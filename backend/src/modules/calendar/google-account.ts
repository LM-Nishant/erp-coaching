import { Op } from 'sequelize';
import { config } from '../../infrastructure/config';
import { decryptSecret, encryptSecret, sha256 } from '../../infrastructure/crypto';
import { logger } from '../../infrastructure/logger';
import {
  CalendarProviderError,
  GoogleCalendarProvider,
  refreshGoogleToken,
  revokeGoogleToken,
  type GoogleOAuthClient,
} from '../../infrastructure/calendar';
import { audit } from '../../shared/audit/audit.service';
import { CalendarConnection } from './calendar.models';

/**
 * Google accounts behind calendar connections: the platform's OAuth client, short-lived access
 * tokens (kept in memory only) and the reconnect state. Refresh tokens are stored encrypted with
 * the shared encryption helper and never leave the API or reach the logs.
 */

/** The SaaS-level OAuth client; null while calendars use the mock provider. */
export function googleClient(): GoogleOAuthClient | null {
  const {
    CALENDAR_PROVIDER,
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
  } = config;
  if (CALENDAR_PROVIDER !== 'google' || !clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: config.googleOAuthRedirectUri };
}

/** Public origin of this API, without a trailing slash. */
export const apiBase = () => config.API_PUBLIC_URL.replace(/\/+$/, '');

interface CachedToken {
  token: string;
  expiresAt: number;
  /** Hash of the stored refresh token it came from, so a reconnect never reuses the old grant. */
  grant: string;
}
const accessTokens = new Map<number, CachedToken>();
const EXPIRY_MARGIN_MS = 60_000;

export const forgetAccessToken = (connectionId: number) => accessTokens.delete(connectionId);

/** Tests only. */
export const resetCalendarAccessTokens = () => accessTokens.clear();

/** Keeps the access token from the consent exchange so the first sync skips a refresh. */
export function rememberAccessToken(
  conn: Pick<CalendarConnection, 'id' | 'refreshTokenEncrypted'>,
  token: string,
  expiresIn: number,
) {
  accessTokens.set(conn.id, {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
    grant: sha256(conn.refreshTokenEncrypted),
  });
}

async function accessToken(conn: CalendarConnection, forceRefresh: boolean, signal?: AbortSignal) {
  const cached = accessTokens.get(conn.id);
  if (
    !forceRefresh &&
    cached?.grant === sha256(conn.refreshTokenEncrypted) &&
    cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  )
    return cached.token;
  const client = googleClient();
  if (!client)
    throw new CalendarProviderError('invalid', 'Google Calendar is not configured on this platform');
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(conn.refreshTokenEncrypted);
  } catch {
    throw new CalendarProviderError('auth', 'The stored Google authorisation could not be read');
  }
  const tokens = await refreshGoogleToken(client, refreshToken, { signal });
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    // Google rotated the refresh token; keep the new one, encrypted like the first.
    const refreshTokenEncrypted = encryptSecret(tokens.refreshToken);
    await CalendarConnection.update(
      { refreshTokenEncrypted },
      { where: { instituteId: conn.instituteId, id: conn.id } },
    );
    conn.set('refreshTokenEncrypted', refreshTokenEncrypted);
  }
  rememberAccessToken(conn, tokens.accessToken, tokens.expiresIn);
  return tokens.accessToken;
}

/** Calendar API client acting as the connection's Google account (its primary calendar). */
export function googleProviderFor(conn: CalendarConnection, signal?: AbortSignal) {
  return new GoogleCalendarProvider({
    accessToken: (forceRefresh) => accessToken(conn, Boolean(forceRefresh), signal),
    signal,
  });
}

/**
 * Google revoked or expired the grant, or it lost the calendar permission: flag the connection so
 * its owner sees "Reconnect" and syncs stop using it. Logged and audited once per incident.
 */
export async function markNeedsReconnect(conn: CalendarConnection, reason: string) {
  forgetAccessToken(conn.id);
  const lastError = reason.slice(0, 500);
  const [changed] = await CalendarConnection.update(
    { status: 'needs_reconnect', lastError },
    { where: { instituteId: conn.instituteId, id: conn.id, status: 'active' } },
  );
  conn.set({ status: 'needs_reconnect', lastError });
  if (!changed) return;
  logger.warn(
    { instituteId: conn.instituteId, connectionId: conn.id, reason: lastError },
    'Google Calendar access lost; the connection needs to be reconnected',
  );
  await audit({
    action: 'calendar.needs_reconnect',
    entityType: 'calendar_connection',
    entityId: conn.id,
    instituteId: conn.instituteId,
    metadata: { owner: conn.ownerKey, accountEmail: conn.accountEmail, reason: lastError.slice(0, 200) },
  });
}

export type RevokeOutcome = 'revoked' | 'shared' | 'skipped' | 'failed';

/**
 * Best-effort revoke of a token we no longer keep. Skipped in mock mode, and while a connection
 * (other than `exceptConnectionId`) uses the same Google account: revoking any token ends the
 * account's whole grant to this app, including that connection's.
 */
export async function revokeUnlessShared(
  accountId: string,
  token: string,
  exceptConnectionId = 0,
): Promise<RevokeOutcome> {
  if (!googleClient()) return 'skipped';
  // Platform-wide on purpose: the same Google account may be connected in another institute.
  const others = await CalendarConnection.count({
    where: { accountId, id: { [Op.ne]: exceptConnectionId } },
    tenantBypass: true,
  } as object);
  if (others) return 'shared';
  return (await revokeGoogleToken(token)) ? 'revoked' : 'failed';
}

/** Revokes a connection's grant when it is removed or replaced by another account. */
export async function revokeGrant(
  conn: Pick<CalendarConnection, 'id' | 'accountId' | 'refreshTokenEncrypted'>,
): Promise<RevokeOutcome> {
  if (!googleClient()) return 'skipped';
  let token: string;
  try {
    token = decryptSecret(conn.refreshTokenEncrypted);
  } catch {
    return 'failed';
  }
  return revokeUnlessShared(conn.accountId, token, conn.id);
}
