import { Op, UniqueConstraintError } from 'sequelize';
import type { CalendarConnectClient, CalendarConnectResult, CalendarConnectStartDto } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256 } from '../../infrastructure/crypto';
import { logger } from '../../infrastructure/logger';
import {
  exchangeGoogleCode,
  GOOGLE_EVENTS_SCOPE,
  googleAuthUrl,
  googleIdentity,
  type GoogleTokens,
} from '../../infrastructure/calendar';
import { audit } from '../../shared/audit/audit.service';
import { getContext, requireTenantContext, runWithContext } from '../../shared/context';
import { BadRequest, Conflict, TooManyRequests } from '../../shared/errors';
import { User } from '../users/user.model';
import { CalendarConnection, CalendarEventLink, CalendarOAuthState, ownerKeyOf } from './calendar.models';
import {
  apiBase,
  googleClient,
  rememberAccessToken,
  revokeGrant,
  revokeUnlessShared,
} from './google-account';
import { queueAfterConnect } from './sync.service';

/**
 * Connecting a Google account: OAuth 2.0 authorization code flow with PKCE, started from the app.
 *
 * 1. The signed-in user asks for a start link (`startConnect`): a random single-use `state` valid
 *    for 10 minutes. Only its hash is stored; the PKCE verifier is stored encrypted.
 * 2. The browser opens the link (`beginConsent`). The first browser to open it gets a cookie that
 *    binds the flow to it, and is sent to Google's consent screen.
 * 3. Google redirects back (`completeConsent`). The state must be unused, unexpired and come with
 *    the cookie; the code is exchanged once, with the verifier, for a refresh token that is stored
 *    encrypted. Repeats of the callback show the stored result, so it is idempotent.
 *
 * The start link exists because the app authenticates with bearer tokens, which a top-level
 * navigation (or the phone's system browser) cannot send.
 */
export const CONSENT_PATH = '/api/calendar/public/google';
export const STATE_TTL_MS = 10 * 60_000;
const STATE_RETENTION_MS = 24 * 60 * 60_000;
const MAX_OPEN_STATES = 10;

export interface ConsentReply {
  status: number;
  /** Redirect target, with status 302. */
  location?: string;
  html?: string;
  /** Binds the flow to the browser that opened the start link. */
  setCookie?: { name: string; value: string };
  clearCookie?: string;
}

/** Per flow, so two consent tabs in one browser do not overwrite each other's cookie. */
const cookieName = (stateHash: string) => `erp_gcal_${stateHash.slice(0, 16)}`;

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

const nonceMatches = (state: CalendarOAuthState, cookieHeader: string | undefined) => {
  const nonce = readCookie(cookieHeader, cookieName(state.stateHash));
  return Boolean(nonce && state.nonceHash && safeEqual(sha256(nonce), state.nonceHash));
};

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** A small script-free page (the routes send it with a strict CSP). */
function page(status: number, title: string, message: string, refresh = false): ConsentReply {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${refresh ? '\n<meta http-equiv="refresh" content="2">' : ''}
<title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#1f2937;line-height:1.5}h1{font-size:1.35rem}</style>
</head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body>
</html>
`;
  return { status, html };
}

const invalidLink = () =>
  page(400, 'Link not valid', 'This Google Calendar link is not valid. Start again from the app.');
const inAnotherBrowser = () =>
  page(
    409,
    'Link opened in another browser',
    'This Google Calendar link was already opened in another browser. Start again from the app.',
  );

const RESULT_PAGES: Record<CalendarConnectResult, [string, string]> = {
  connected: ['Google Calendar connected', 'You can close this page and return to the app.'],
  denied: ['Google Calendar not connected', 'Access was not allowed. Return to the app to try again.'],
  missing_scope: [
    'Calendar access needed',
    'Google Calendar was not connected because access to calendar events was not allowed. Return to the app and try again, leaving the calendar permission selected.',
  ],
  expired: ['Link expired', 'The connection took too long. Return to the app and connect again.'],
  error: ['Google Calendar not connected', 'Something went wrong. Return to the app and try again.'],
};

/** Where the browser goes when the flow ends: back into the web app, or a "return to the app" page. */
function finish(state: CalendarOAuthState, result: CalendarConnectResult): ConsentReply {
  const clearCookie = cookieName(state.stateHash);
  if (state.client === 'web') {
    const path = state.ownerUserId ? '/appointments/availability' : '/calendar';
    return { status: 302, location: `${config.publicWebUrl}${path}?calendar=${result}`, clearCookie };
  }
  const [title, message] = RESULT_PAGES[result];
  return { ...page(200, title, message), clearCookie };
}

const findState = (rawState: string) =>
  CalendarOAuthState.findOne({ where: { stateHash: sha256(rawState) }, tenantBypass: true } as object);

/** Pre-fills Google's account chooser: the account connected before, else the teacher's email. */
async function loginHintFor(state: CalendarOAuthState) {
  const conn = await CalendarConnection.findOne({
    where: { instituteId: state.instituteId, ownerKey: ownerKeyOf(state.ownerUserId) },
    attributes: ['accountEmail'],
  });
  if (conn?.accountEmail) return conn.accountEmail;
  if (!state.ownerUserId) return null;
  return (await User.findByPk(state.ownerUserId, { attributes: ['email'] }))?.email ?? null;
}

/** Step 1: a start link for the signed-in user (`organiser`: the institute's calendar). */
export async function startConnect(
  owner: 'me' | 'organiser',
  client: CalendarConnectClient,
): Promise<CalendarConnectStartDto> {
  const ctx = requireTenantContext();
  if (ctx.impersonatorId) throw BadRequest('Calendars cannot be connected while impersonating');
  if (!ctx.userId) throw BadRequest('Sign in to connect a calendar');
  if (!googleClient())
    throw Conflict('Google Calendar is not configured on this platform', 'CALENDAR_NOT_CONFIGURED');
  const { instituteId, userId } = ctx;
  const now = Date.now();
  await CalendarOAuthState.destroy({
    where: { instituteId, createdAt: { [Op.lt]: new Date(now - STATE_RETENTION_MS) } },
  });
  const open = await CalendarOAuthState.count({
    where: { instituteId, userId, usedAt: null, expiresAt: { [Op.gt]: new Date(now) } },
  });
  if (open >= MAX_OPEN_STATES)
    throw TooManyRequests('Too many Google Calendar connections started. Try again in a few minutes.');

  const state = randomToken(32);
  const expiresAt = new Date(now + STATE_TTL_MS);
  await CalendarOAuthState.create({
    instituteId,
    userId,
    ownerUserId: owner === 'me' ? userId : null,
    stateHash: sha256(state),
    codeVerifierEncrypted: encryptSecret(randomToken(48)),
    client,
    expiresAt,
  });
  return {
    startUrl: `${apiBase()}${CONSENT_PATH}/start?state=${encodeURIComponent(state)}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Step 2: the start link opens; bind the flow to this browser and go to Google's consent screen. */
export async function beginConsent(rawState: string, cookieHeader?: string): Promise<ConsentReply> {
  const state = await findState(rawState);
  if (!state) return invalidLink();
  const now = new Date();
  const verifier = state.codeVerifierEncrypted;
  if (state.usedAt || !verifier || state.expiresAt <= now)
    return page(
      410,
      'Link expired',
      'This Google Calendar link has expired or was already used. Start again from the app.',
    );
  const client = googleClient();
  if (!client)
    return page(503, 'Google Calendar unavailable', 'Google Calendar is not configured on this platform.');

  const consentUrl = async () =>
    googleAuthUrl(client, {
      state: rawState,
      codeVerifier: decryptSecret(verifier),
      loginHint: await loginHintFor(state),
    });
  if (state.startedAt) {
    // The same browser again (reload, back button): carry on. Any other browser is refused.
    return nonceMatches(state, cookieHeader)
      ? { status: 302, location: await consentUrl() }
      : inAnotherBrowser();
  }
  const nonce = randomToken(32);
  const [claimed] = await CalendarOAuthState.update(
    { startedAt: now, nonceHash: sha256(nonce) },
    { where: { instituteId: state.instituteId, id: state.id, startedAt: null } },
  );
  if (!claimed) return inAnotherBrowser();
  return {
    status: 302,
    location: await consentUrl(),
    setCookie: { name: cookieName(state.stateHash), value: nonce },
  };
}

export interface ConsentCallback {
  state?: string;
  code?: string;
  error?: string;
}

/** Step 3: Google redirects back with a code (or an error). */
export async function completeConsent(q: ConsentCallback, cookieHeader?: string): Promise<ConsentReply> {
  const state = q.state ? await findState(q.state) : null;
  if (!state) return invalidLink();
  const shown = (s: CalendarOAuthState) =>
    s.result ? finish(s, s.result) : page(200, 'Connecting Google Calendar…', 'Please wait.', true);
  if (state.usedAt) return shown(state);
  if (!nonceMatches(state, cookieHeader))
    return page(
      400,
      'Use the same browser',
      'Finish connecting Google Calendar in the browser where you started. Start again from the app.',
    );

  const verifier = state.codeVerifierEncrypted;
  // Single use: claim the state, and drop the verifier, before talking to Google.
  const [claimed] = await CalendarOAuthState.update(
    { usedAt: new Date(), codeVerifierEncrypted: null },
    { where: { instituteId: state.instituteId, id: state.id, usedAt: null } },
  );
  if (!claimed) {
    const again = await findState(q.state!);
    return again ? shown(again) : invalidLink();
  }

  let result: CalendarConnectResult;
  if (state.expiresAt <= new Date()) result = 'expired';
  else if (q.error) result = q.error === 'access_denied' ? 'denied' : 'error';
  else if (!q.code || !verifier) result = 'error';
  else {
    const ctx = {
      ...getContext(),
      system: true,
      instituteId: state.instituteId,
      userId: state.userId,
      allowedBranchIds: null,
    };
    result = await runWithContext(ctx, async () => connect(state, q.code!, decryptSecret(verifier))).catch(
      (err: unknown) => {
        logger.error({ err, instituteId: state.instituteId }, 'Google Calendar could not be connected');
        return 'error' as const;
      },
    );
  }
  if (q.error && q.error !== 'access_denied')
    logger.warn(
      { error: q.error.slice(0, 100), instituteId: state.instituteId },
      'Google returned an OAuth error',
    );
  await CalendarOAuthState.update({ result }, { where: { instituteId: state.instituteId, id: state.id } });
  return finish(state, result);
}

type ConnectionValues = Pick<
  CalendarConnection,
  | 'accountId'
  | 'accountEmail'
  | 'scopes'
  | 'refreshTokenEncrypted'
  | 'status'
  | 'lastError'
  | 'connectedByUserId'
  | 'connectedAt'
  | 'lastCheckedAt'
>;
type Replaced = Pick<CalendarConnection, 'id' | 'accountId' | 'accountEmail' | 'refreshTokenEncrypted'>;

/** One connection per owner: connecting again replaces the account (or just its token). */
async function saveConnection(state: CalendarOAuthState, values: ConnectionValues) {
  const { instituteId } = state;
  const where = { instituteId, ownerKey: ownerKeyOf(state.ownerUserId) };
  for (let attempt = 0; ; attempt++) {
    const existing = await CalendarConnection.findOne({ where });
    if (existing) {
      let replaced: Replaced | null = null;
      if (existing.accountId !== values.accountId) {
        const { id, accountId, accountEmail, refreshTokenEncrypted } = existing;
        replaced = { id, accountId, accountEmail, refreshTokenEncrypted };
        // Events made so far stay in the old account's calendar; later changes go to the new one.
        await CalendarEventLink.update(
          { connectionId: null },
          { where: { instituteId, connectionId: existing.id } },
        );
      }
      await CalendarConnection.update(values, { where: { instituteId, id: existing.id } });
      existing.set(values);
      return { conn: existing, replaced };
    }
    try {
      const conn = await CalendarConnection.create({ ...where, userId: state.ownerUserId, ...values });
      return { conn, replaced: null };
    } catch (err) {
      // Another consent for the same owner finished first: update that connection instead.
      if (!(err instanceof UniqueConstraintError) || attempt > 0) throw err;
    }
  }
}

async function connect(
  state: CalendarOAuthState,
  code: string,
  verifier: string,
): Promise<CalendarConnectResult> {
  const client = googleClient();
  if (!client) return 'error';
  let tokens: GoogleTokens;
  let identity: { accountId: string; email: string };
  try {
    tokens = await exchangeGoogleCode(client, code, verifier);
    // Without an identity the token cannot be checked against other connections, so it is
    // dropped unrevoked (it is useless without the client secret).
    identity = googleIdentity(tokens.idToken, client.clientId);
  } catch (err) {
    logger.warn(
      { instituteId: state.instituteId, reason: err instanceof Error ? err.message : String(err) },
      'Google Calendar consent could not be completed',
    );
    return 'error';
  }
  const discard = () => revokeUnlessShared(identity.accountId, tokens.refreshToken ?? tokens.accessToken);
  if (!tokens.scopes.includes(GOOGLE_EVENTS_SCOPE)) {
    await discard();
    return 'missing_scope';
  }
  if (!tokens.refreshToken) {
    // Only happens if Google ignored prompt=consent; nothing could sync once the access token expires.
    logger.warn({ instituteId: state.instituteId }, 'Google returned no refresh token');
    await discard();
    return 'error';
  }

  const now = new Date();
  const { conn, replaced } = await saveConnection(state, {
    accountId: identity.accountId,
    accountEmail: identity.email,
    scopes: tokens.scopes.join(' ').slice(0, 1000),
    refreshTokenEncrypted: encryptSecret(tokens.refreshToken),
    status: 'active',
    lastError: null,
    connectedByUserId: state.userId,
    connectedAt: now,
    lastCheckedAt: now,
  });
  rememberAccessToken(conn, tokens.accessToken, tokens.expiresIn);
  // A different account replaced the old one: end the old grant (same account: keep it, since
  // revoking any of its tokens would end the new one too).
  const revoked = replaced ? await revokeGrant(replaced) : null;
  await audit({
    action: 'calendar.connected',
    entityType: 'calendar_connection',
    entityId: conn.id,
    instituteId: state.instituteId,
    metadata: {
      owner: conn.ownerKey,
      accountEmail: conn.accountEmail,
      ...(replaced ? { replacedAccountEmail: replaced.accountEmail, revoked } : {}),
    },
  });
  try {
    await queueAfterConnect(conn);
  } catch (err) {
    logger.warn({ err, connectionId: conn.id }, 'Could not queue calendar syncs after connecting');
  }
  return 'connected';
}
