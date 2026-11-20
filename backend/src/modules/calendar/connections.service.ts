import { Op } from 'sequelize';
import type {
  CalendarConnectionDto,
  CalendarPlatformStatusDto,
  CalendarSettingsDto,
  CalendarTestResultDto,
  MyCalendarDto,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import { logger } from '../../infrastructure/logger';
import { CalendarProviderError, checkGoogleClient, GOOGLE_SCOPES } from '../../infrastructure/calendar';
import { audit } from '../../shared/audit/audit.service';
import { requireTenantContext } from '../../shared/context';
import { NotFound, Unauthorized } from '../../shared/errors';
import { User } from '../users/user.model';
import { CalendarConnection, ownerKeyOf } from './calendar.models';
import {
  forgetAccessToken,
  googleClient,
  googleProviderFor,
  markNeedsReconnect,
  revokeGrant,
} from './google-account';
import { queueAfterConnect, syncCounts } from './sync.service';

const TEST_BUDGET_MS = 15_000;
const withUsers = [
  { model: User, as: 'user', attributes: ['id', 'name'] },
  { model: User, as: 'connectedBy', attributes: ['id', 'name'] },
];

function toDto(c: CalendarConnection): CalendarConnectionDto {
  return {
    id: c.id,
    userId: c.userId,
    userName: c.user?.name ?? null,
    provider: 'google',
    accountEmail: c.accountEmail,
    status: c.status,
    lastError: c.lastError,
    connectedAt: c.connectedAt.toISOString(),
    connectedBy: c.connectedBy ? { id: c.connectedBy.id, name: c.connectedBy.name } : null,
    lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
  };
}

function currentUser() {
  const ctx = requireTenantContext();
  if (!ctx.userId) throw Unauthorized();
  return { instituteId: ctx.instituteId, userId: ctx.userId };
}

/** Institute settings: the organiser calendar, every teacher's own, and sync totals. */
export async function calendarSettings(): Promise<CalendarSettingsDto> {
  const { instituteId } = requireTenantContext();
  const conns = await CalendarConnection.findAll({
    where: { instituteId },
    include: withUsers,
    order: [['id', 'ASC']],
  });
  const organiser = conns.find((c) => c.userId === null);
  return {
    provider: config.CALENDAR_PROVIDER,
    configured: Boolean(googleClient()),
    organiser: organiser ? toDto(organiser) : null,
    teachers: conns.filter((c) => c.userId !== null).map(toDto),
    sync: await syncCounts(instituteId),
  };
}

export async function myCalendar(): Promise<MyCalendarDto> {
  const { instituteId, userId } = currentUser();
  const conns = await CalendarConnection.findAll({
    where: { instituteId, ownerKey: { [Op.in]: [ownerKeyOf(userId), ownerKeyOf(null)] } },
    include: withUsers,
  });
  const mine = conns.find((c) => c.userId === userId);
  return {
    provider: config.CALENDAR_PROVIDER,
    configured: Boolean(googleClient()),
    connection: mine ? toDto(mine) : null,
    organiserConnected: conns.some((c) => c.userId === null && c.status === 'active'),
  };
}

async function mine() {
  const { instituteId, userId } = currentUser();
  const conn = await CalendarConnection.findOne({ where: { instituteId, ownerKey: ownerKeyOf(userId) } });
  if (!conn) throw NotFound('Calendar connection');
  return conn;
}

async function byId(id: number) {
  const { instituteId } = requireTenantContext();
  const conn = await CalendarConnection.findOne({ where: { instituteId, id } });
  if (!conn) throw NotFound('Calendar connection');
  return conn;
}

/**
 * Refreshes the token and reads the calendar, so a revoked grant shows up now rather than at the
 * next sync. A pass clears the reconnect state and retries the events waiting on this calendar.
 */
async function testConnection(conn: CalendarConnection): Promise<CalendarTestResultDto> {
  if (!googleClient()) return { ok: false, message: 'Google Calendar is not configured on this platform' };
  forgetAccessToken(conn.id);
  let result: CalendarTestResultDto;
  try {
    const info = await googleProviderFor(conn, AbortSignal.timeout(TEST_BUDGET_MS)).testConnection();
    const wasBroken = conn.status !== 'active';
    const values = { status: 'active' as const, lastError: null, lastCheckedAt: new Date() };
    await CalendarConnection.update(values, { where: { instituteId: conn.instituteId, id: conn.id } });
    conn.set(values);
    result = {
      ok: true,
      message: `Connected to ${conn.accountEmail ?? 'Google Calendar'}`,
      calendar: info.calendar,
      timeZone: info.timeZone,
    };
    await queueAfterConnect(conn, { upcoming: wasBroken }).catch((err: unknown) =>
      logger.warn({ err, connectionId: conn.id }, 'Could not queue calendar syncs after a test'),
    );
  } catch (err) {
    if (!(err instanceof CalendarProviderError)) throw err;
    if (err.kind === 'auth') await markNeedsReconnect(conn, err.message);
    result = {
      ok: false,
      message:
        err.kind === 'auth'
          ? `Google access was revoked or has expired. Reconnect the calendar. (${err.message})`
          : err.message,
    };
  }
  await audit({
    action: 'calendar.tested',
    entityType: 'calendar_connection',
    entityId: conn.id,
    metadata: { owner: conn.ownerKey, ok: result.ok },
  });
  return result;
}

/**
 * Removes the connection and revokes its grant (best effort). Events already in Google stay
 * there; later changes go to whichever calendar is connected then.
 */
async function disconnect(conn: CalendarConnection) {
  const revoked = await revokeGrant(conn);
  await CalendarConnection.destroy({ where: { instituteId: conn.instituteId, id: conn.id } });
  forgetAccessToken(conn.id);
  await audit({
    action: 'calendar.disconnected',
    entityType: 'calendar_connection',
    entityId: conn.id,
    metadata: { owner: conn.ownerKey, accountEmail: conn.accountEmail, revoked },
  });
}

export const testMyCalendar = async () => testConnection(await mine());
export const disconnectMyCalendar = async () => disconnect(await mine());
export const testCalendarConnection = async (id: number) => testConnection(await byId(id));
export const disconnectCalendarConnection = async (id: number) => disconnect(await byId(id));

/** Super admin: the platform's OAuth client and what to register in Google Cloud. */
export async function platformCalendarStatus(): Promise<CalendarPlatformStatusDto> {
  const count = (status: 'active' | 'needs_reconnect') =>
    CalendarConnection.count({ where: { status }, tenantBypass: true } as object);
  const [active, needsReconnect] = await Promise.all([count('active'), count('needs_reconnect')]);
  return {
    provider: config.CALENDAR_PROVIDER,
    configured: Boolean(googleClient()),
    clientId: config.GOOGLE_OAUTH_CLIENT_ID || null,
    redirectUri: config.googleOAuthRedirectUri,
    scopes: GOOGLE_SCOPES,
    connections: { active, needsReconnect },
  };
}

export async function testPlatformCalendar(): Promise<CalendarTestResultDto> {
  const client = googleClient();
  if (!client)
    return {
      ok: false,
      message: 'Google Calendar is off (CALENDAR_PROVIDER=mock): events use the mock calendar',
    };
  return checkGoogleClient(client);
}
