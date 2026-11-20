import { Op, UniqueConstraintError, type InferAttributes } from 'sequelize';
import type { CalendarSyncCountsDto, CalendarSyncDto } from '@erp/shared';
import { sha256 } from '../../infrastructure/crypto';
import { logger } from '../../infrastructure/logger';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import type { Job } from '../../infrastructure/jobs/job.model';
import {
  CalendarProviderError,
  googleEventId,
  mockCalendarProvider,
  type CalendarEventInput,
  type CalendarEventResult,
  type CalendarProvider,
} from '../../infrastructure/calendar';
import { requireTenantContext } from '../../shared/context';
import { CalendarConnection, CalendarEventLink, ownerKeyOf } from './calendar.models';
import { apiBase, googleClient, googleProviderFor, markNeedsReconnect } from './google-account';

/**
 * Pushes business records (appointments) to calendars. The record is the source of truth: every
 * sync reads its current state and makes the calendar match (create, update, or delete). A sync
 * never fails the business action: it runs after the change is saved, and Google errors are
 * retried by the `calendar.sync` job or shown as the record's sync status.
 */
export const CALENDAR_SYNC_JOB = 'calendar.sync';
/** ~47 minutes of backoff (2^n seconds, capped at 15 minutes). */
const SYNC_MAX_ATTEMPTS = 12;
const INLINE_BUDGET_MS = 10_000;
const JOB_BUDGET_MS = 45_000;
/** Longer than either budget, so a lease never expires under a running sync. */
const LEASE_MS = 60_000;
const RETRY_DELAY_MS = 5_000;
/** Google creates Meet links asynchronously now and then; re-read the event a few times. */
const CONFERENCE_RECHECK_MS = 15_000;
const MAX_CONFERENCE_CHECKS = 5;

export interface CalendarSourceEvent {
  /** Teacher whose own connected calendar is preferred over the institute's organiser calendar. */
  ownerUserId: number | null;
  event: Omit<CalendarEventInput, 'externalRef' | 'requestId'>;
  /** A link entered by hand: no Meet link is created, and the link goes in the description. */
  customMeetingUrl?: string | null;
}

export interface CalendarSyncResult {
  provider: string;
  eventId: string | null;
  meetingUrl: string | null;
}

export interface CalendarSource {
  /** The event the record should have now; null when it should have none (not confirmed). */
  load(sourceId: number): Promise<CalendarSourceEvent | null>;
  /** Stores the event id and meeting link on the record. */
  saved(sourceId: number, result: CalendarSyncResult): Promise<void>;
  /** Upcoming record ids to push once `ownerUserId` (null = the organiser) connects a calendar. */
  upcoming?(ownerUserId: number | null): Promise<number[]>;
}

const sources = new Map<string, CalendarSource>();

export function registerCalendarSource(key: string, source: CalendarSource): void {
  sources.set(key, source);
}

type Outcome = 'done' | 'busy' | 'retry' | 'recheck';

interface Target {
  provider: CalendarProvider;
  /** null for the mock provider. */
  connection: CalendarConnection | null;
  /** Set when the calendar needs its owner to reconnect; nothing is sent to it meanwhile. */
  blocked: string | null;
}

const RECONNECT = 'Reconnect Google Calendar to sync this event';
const NOT_CONNECTED = 'No Google Calendar is connected';

type LinkValues = Partial<InferAttributes<CalendarEventLink>>;

async function save(link: CalendarEventLink, values: LinkValues) {
  await CalendarEventLink.update(values, { where: { instituteId: link.instituteId, id: link.id } });
  link.set(values as InferAttributes<CalendarEventLink>);
}

const fail = (link: CalendarEventLink, message: string) =>
  save(link, { status: 'failed', lastError: message.slice(0, 500), contentHash: null, attempts: 0 });

/** Idempotency key for the link's current event; also gives Google events a deterministic id. */
const requestIdOf = (link: CalendarEventLink) =>
  `${apiBase()}|${link.instituteId}|${link.source}|${link.sourceId}|${link.generation}`;

const leaseUntil = () => new Date(Date.now() + LEASE_MS);

const mockTarget = (): Target => ({ provider: mockCalendarProvider, connection: null, blocked: null });

const target = (conn: CalendarConnection, signal: AbortSignal): Target => ({
  provider: googleProviderFor(conn, signal),
  connection: conn,
  blocked: conn.status === 'active' ? null : RECONNECT,
});

/** The calendar that holds the link's event (the same Google account, even after a reconnect). */
async function holderOf(link: CalendarEventLink, signal: AbortSignal): Promise<Target | null> {
  if (link.provider === 'mock') return mockTarget();
  if (!googleClient()) return null;
  const { instituteId } = link;
  const byId = link.connectionId
    ? await CalendarConnection.findOne({ where: { instituteId, id: link.connectionId } })
    : null;
  const conn =
    byId ??
    (link.accountId
      ? await CalendarConnection.findOne({
          where: { instituteId, accountId: link.accountId },
          order: [['status', 'ASC']], // 'active' before 'needs_reconnect'
        })
      : null);
  return conn ? target(conn, signal) : null;
}

/** Where a new event goes: the teacher's own calendar, else the institute's organiser calendar. */
async function preferredTarget(
  instituteId: number,
  ownerUserId: number | null,
  signal: AbortSignal,
): Promise<Target | null> {
  if (!googleClient()) return mockTarget();
  const keys = ownerUserId ? [ownerKeyOf(ownerUserId), ownerKeyOf(null)] : [ownerKeyOf(null)];
  const conns = await CalendarConnection.findAll({ where: { instituteId, ownerKey: { [Op.in]: keys } } });
  // A teacher's connection that needs reconnecting blocks rather than silently falling back.
  const conn = keys.map((k) => conns.find((c) => c.ownerKey === k)).find(Boolean);
  return conn ? target(conn, signal) : null;
}

const sameCalendar = (link: CalendarEventLink, t: Target) =>
  t.connection
    ? link.provider === 'google' && link.accountId === t.connection.accountId
    : link.provider === t.provider.name;

/** Takes the link's lease; false while another sync of the same record runs. */
async function lease(instituteId: number, source: string, sourceId: number) {
  const now = new Date();
  const [n] = await CalendarEventLink.update(
    { lockedUntil: leaseUntil() },
    {
      where: {
        instituteId,
        source,
        sourceId,
        [Op.or]: [{ lockedUntil: null }, { lockedUntil: { [Op.lt]: now } }],
      },
    },
  );
  return n > 0;
}

async function reconcile(
  instituteId: number,
  sourceKey: string,
  sourceId: number,
  signal: AbortSignal,
): Promise<Outcome> {
  const source = sources.get(sourceKey);
  if (!source) throw new Error(`Unknown calendar source: ${sourceKey}`);
  const where = { instituteId, source: sourceKey, sourceId };
  const leased = await lease(instituteId, sourceKey, sourceId);
  let link = await CalendarEventLink.findOne({ where });
  if (link && !leased) return 'busy';
  let holder: Target | null = null;
  try {
    const desired = await source.load(sourceId);

    if (!desired) {
      if (!link || link.status === 'deleted') return 'done';
      holder = await holderOf(link, signal);
      // A create that timed out may still have made the event: its id is deterministic.
      const eventId =
        link.eventId ?? (link.provider === 'google' && holder ? googleEventId(requestIdOf(link)) : null);
      if (link.eventId && (!holder || holder.blocked)) {
        await fail(link, holder?.blocked ?? `${NOT_CONNECTED}, so the event could not be removed`);
        return 'done';
      }
      if (eventId && holder && !holder.blocked) await holder.provider.cancelEvent(eventId);
      await source.saved(sourceId, { provider: link.provider, eventId: null, meetingUrl: null });
      // Deleted Google event ids are never reusable: the next event gets a new generation.
      await save(link, {
        status: 'deleted',
        eventId: null,
        meetingUrl: null,
        contentHash: null,
        generation: link.generation + 1,
        attempts: 0,
        lastError: null,
        syncedAt: new Date(),
      });
      return 'done';
    }

    // Keep an event in the calendar that already holds it (moving it would re-invite everyone).
    const placed =
      link &&
      link.status !== 'deleted' &&
      link.provider === (googleClient() ? 'google' : 'mock') &&
      (link.eventId || link.connectionId || link.accountId);
    holder =
      (placed ? await holderOf(link!, signal) : null) ??
      (await preferredTarget(instituteId, desired.ownerUserId, signal));
    if (!holder) {
      // Recorded so the record shows why it has no event; connecting a calendar picks it up.
      if (link) await fail(link, NOT_CONNECTED);
      else
        await CalendarEventLink.create({
          ...where,
          provider: 'google',
          connectionId: null,
          accountId: null,
          status: 'failed',
          lastError: NOT_CONNECTED,
        }).catch((err: unknown) => {
          if (!(err instanceof UniqueConstraintError)) throw err;
        });
      return 'done';
    }
    const placement = {
      provider: holder.provider.name,
      connectionId: holder.connection?.id ?? null,
      accountId: holder.connection?.accountId ?? null,
    };
    if (!link) {
      try {
        link = await CalendarEventLink.create({ ...where, ...placement, lockedUntil: leaseUntil() });
      } catch (err) {
        if (err instanceof UniqueConstraintError) return 'busy';
        throw err;
      }
    } else if (!sameCalendar(link, holder)) {
      // A different calendar: start a new event there (a new id, since ids are per idempotency key).
      await save(link, {
        ...placement,
        eventId: null,
        meetingUrl: null,
        contentHash: null,
        generation: link.generation + 1,
        attempts: 0,
        status: 'pending',
      });
    } else if (link.connectionId !== placement.connectionId) {
      await save(link, { connectionId: placement.connectionId }); // same account, connected again
    }
    if (holder.blocked) {
      await fail(link, holder.blocked);
      return 'done';
    }

    const custom = desired.customMeetingUrl?.trim() || null;
    const event: Omit<CalendarEventInput, 'requestId'> = {
      ...desired.event,
      externalRef: `${sourceKey}:${sourceId}`,
      withMeeting: desired.event.withMeeting && !custom,
      description: custom
        ? [desired.event.description, `Meeting link: ${custom}`].filter(Boolean).join('\n\n')
        : desired.event.description,
    };
    const hash = sha256(
      JSON.stringify({ event, custom, provider: placement.provider, account: placement.accountId }),
    );
    if (link.status === 'synced' && link.eventId && link.contentHash === hash) return 'done';

    const write = (l: CalendarEventLink): Promise<CalendarEventResult> =>
      l.eventId
        ? holder!.provider.updateEvent(l.eventId, { ...event, requestId: requestIdOf(l) })
        : holder!.provider.createEvent({ ...event, requestId: requestIdOf(l) });
    let result: CalendarEventResult;
    try {
      result = await write(link);
    } catch (err) {
      if (!(err instanceof CalendarProviderError) || err.kind !== 'not_found') throw err;
      // Deleted in Google, or its id belonged to a deleted event: create a fresh one.
      await save(link, { eventId: null, generation: link.generation + 1 });
      result = await write(link);
    }

    const meetingUrl = custom ?? (event.withMeeting ? result.meetingUrl : null);
    await source.saved(sourceId, { provider: placement.provider, eventId: result.eventId, meetingUrl });
    const recheck = Boolean(result.conferencePending) && link.attempts + 1 < MAX_CONFERENCE_CHECKS;
    await save(link, {
      eventId: result.eventId,
      meetingUrl,
      contentHash: recheck ? null : hash,
      status: recheck ? 'pending' : 'synced',
      attempts: recheck ? link.attempts + 1 : 0,
      lastError: result.conferencePending && !recheck ? 'Google did not create a Meet link' : null,
      syncedAt: new Date(),
    });
    return recheck ? 'recheck' : 'done';
  } catch (err) {
    return failed(link, holder, err);
  } finally {
    if (link)
      await CalendarEventLink.update({ lockedUntil: null }, { where: { instituteId, id: link.id } }).catch(
        (err: unknown) => logger.warn({ err, linkId: link?.id }, 'Could not release a calendar sync lease'),
      );
  }
}

async function failed(link: CalendarEventLink | null, holder: Target | null, err: unknown): Promise<Outcome> {
  const e = err instanceof CalendarProviderError ? err : null;
  if (e?.kind === 'auth' && holder?.connection) await markNeedsReconnect(holder.connection, e.message);
  if (e && e.kind !== 'retryable') {
    if (link) await fail(link, e.kind === 'auth' ? `${RECONNECT}: ${e.message}` : e.message);
    return 'done';
  }
  // Retryable (rate limit, 5xx, timeout) or unexpected (database): retry in the background.
  const message = e?.message ?? (err instanceof Error ? err.message : String(err));
  if (!e) logger.warn({ err }, 'Calendar sync failed unexpectedly');
  if (link) await save(link, { status: 'pending', lastError: message.slice(0, 500) });
  return 'retry';
}

async function enqueueSync(source: string, sourceId: number, delayMs: number, instituteId?: number) {
  await enqueueJob(
    CALENDAR_SYNC_JOB,
    { source, sourceId },
    {
      runAt: new Date(Date.now() + delayMs),
      maxAttempts: SYNC_MAX_ATTEMPTS,
      ...(instituteId ? { instituteId } : {}),
    },
  );
}

/**
 * Brings one record's calendar event up to date. Call after the change is committed. Never
 * throws: failures are retried in the background and shown as the record's sync status.
 */
export async function syncCalendarEvent(source: string, sourceId: number): Promise<void> {
  try {
    const { instituteId } = requireTenantContext();
    const outcome = await reconcile(instituteId, source, sourceId, AbortSignal.timeout(INLINE_BUDGET_MS));
    if (outcome === 'done') return;
    await enqueueSync(source, sourceId, outcome === 'recheck' ? CONFERENCE_RECHECK_MS : RETRY_DELAY_MS);
  } catch (err) {
    logger.warn({ err, source, sourceId }, 'Calendar sync failed; retrying in the background');
    await enqueueSync(source, sourceId, RETRY_DELAY_MS).catch((e: unknown) =>
      logger.error({ err: e, source, sourceId }, 'Could not queue a calendar sync'),
    );
  }
}

/** `calendar.sync` job: throws to retry with backoff. */
export async function runCalendarSyncJob(payload: Record<string, unknown>): Promise<void> {
  const source = String(payload.source);
  const sourceId = Number(payload.sourceId);
  const { instituteId } = requireTenantContext();
  const outcome = await reconcile(instituteId, source, sourceId, AbortSignal.timeout(JOB_BUDGET_MS));
  if (outcome === 'recheck') await enqueueSync(source, sourceId, CONFERENCE_RECHECK_MS);
  else if (outcome === 'busy') throw new Error('Another sync of this event is running');
  else if (outcome === 'retry') {
    const link = await CalendarEventLink.findOne({ where: { instituteId, source, sourceId } });
    throw new Error(link?.lastError ?? 'Calendar sync failed');
  }
}

/** Retries are exhausted: show the record as failed (a later change or reconnect retries it). */
export async function onCalendarSyncJobFailed(job: Job, error: string): Promise<void> {
  const source = job.payload.source;
  const sourceId = Number(job.payload.sourceId);
  if (!job.instituteId || typeof source !== 'string' || !sourceId) return;
  await CalendarEventLink.update(
    { status: 'failed', lastError: `Gave up retrying: ${error}`.slice(0, 500), lockedUntil: null },
    { where: { instituteId: job.instituteId, source, sourceId, status: 'pending' } },
  );
}

/**
 * After a calendar is connected (or passes a test): retry the records waiting on it and, with
 * `upcoming`, push the owner's upcoming records. Runs in the connection's tenant context.
 */
export async function queueAfterConnect(conn: CalendarConnection, { upcoming = true } = {}): Promise<number> {
  const todo = new Map<string, [string, number]>();
  const waiting = await CalendarEventLink.findAll({
    where: {
      instituteId: conn.instituteId,
      status: { [Op.in]: ['pending', 'failed'] },
      [Op.or]: [{ connectionId: conn.id }, { connectionId: null, accountId: conn.accountId }],
    },
    attributes: ['source', 'sourceId'],
    limit: 500,
  });
  for (const l of waiting) todo.set(`${l.source}:${l.sourceId}`, [l.source, l.sourceId]);
  if (upcoming)
    for (const [key, source] of sources)
      for (const id of (await source.upcoming?.(conn.userId)) ?? []) todo.set(`${key}:${id}`, [key, id]);
  for (const [source, id] of todo.values()) await enqueueSync(source, id, 0, conn.instituteId);
  return todo.size;
}

export async function calendarSyncStatus(source: string, sourceId: number): Promise<CalendarSyncDto | null> {
  const { instituteId } = requireTenantContext();
  const link = await CalendarEventLink.findOne({ where: { instituteId, source, sourceId } });
  if (!link) return null;
  return {
    provider: link.provider,
    status: link.status,
    error: link.lastError,
    syncedAt: link.syncedAt?.toISOString() ?? null,
  };
}

/** Where the upcoming records stand in Google Calendar (past ones are no longer actionable). */
export async function syncCounts(instituteId: number): Promise<CalendarSyncCountsDto> {
  const counts = { pending: 0, synced: 0, failed: 0 };
  for (const [key, source] of sources) {
    const ids = (await source.upcoming?.(null)) ?? [];
    if (!ids.length) continue;
    const links = await CalendarEventLink.findAll({
      where: { instituteId, source: key, sourceId: { [Op.in]: ids }, provider: 'google' },
      attributes: ['sourceId', 'status'],
    });
    const status = new Map(links.map((l) => [l.sourceId, l.status]));
    for (const id of ids) {
      const s = status.get(id);
      if (s === 'synced') counts.synced++;
      else if (s === 'pending') counts.pending++;
      else counts.failed++;
    }
  }
  return counts;
}
