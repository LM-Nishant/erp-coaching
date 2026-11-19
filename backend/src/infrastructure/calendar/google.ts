import crypto from 'node:crypto';
import { zonedDateTimeToUtc } from '../../shared/timezone';
import {
  CalendarProviderError,
  type CalendarErrorKind,
  type CalendarEventInput,
  type CalendarEventResult,
  type CalendarProvider,
} from './types';

/**
 * Google Calendar API v3 + Google Meet (conferenceData) over plain HTTPS, and the OAuth 2.0
 * helpers the calendar module uses to connect accounts. No SDK: every call goes through `fetch`,
 * which tests replace (no live Google calls in tests or CI). Messages never include tokens or codes.
 * See docs/integrations/google-calendar.md.
 */
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
/** `openid email` identify the connected account; `calendar.events` manages its events. */
export const GOOGLE_SCOPES = ['openid', 'email', GOOGLE_EVENTS_SCOPE];
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const DEFAULT_TIMEOUT_MS = 10_000;

/** 403 reasons that mean "slow down", not "no access". */
const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
]);
/** 403 reasons that mean the grant no longer covers the calendar (reconnect). */
const AUTH_REASONS = new Set([
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'authError',
  'forbidden',
]);

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function call(url: string, init: RequestInit, what: string, opts: RequestOptions = {}) {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'network error';
    throw new CalendarProviderError('retryable', `Google ${what} request failed (${reason})`);
  }
}

const drain = (res: Response) => res.text().catch(() => '');

interface GoogleErrorBody {
  error?:
    | string
    | {
        message?: string;
        status?: string;
        errors?: { reason?: string }[];
        details?: { reason?: string }[];
      };
  error_description?: string;
}

async function readError(res: Response): Promise<{ reasons: string[]; message: string }> {
  let body: GoogleErrorBody = {};
  try {
    body = (await res.json()) as GoogleErrorBody;
  } catch {
    // Not JSON (proxies, HTML error pages).
  }
  if (typeof body.error === 'string')
    return { reasons: [body.error], message: (body.error_description ?? body.error).slice(0, 300) };
  const e = body.error;
  const reasons = [
    ...(e?.errors ?? []).map((x) => x.reason),
    ...(e?.details ?? []).map((x) => x.reason),
    e?.status,
  ].filter((r): r is string => Boolean(r));
  return { reasons, message: (e?.message ?? res.statusText ?? '').slice(0, 300) };
}

export function classifyGoogleError(status: number, reasons: string[]): CalendarErrorKind {
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429 || status >= 500) return 'retryable';
  if (status === 403 && reasons.some((r) => RATE_REASONS.has(r))) return 'retryable';
  if (status === 401 || (status === 403 && reasons.some((r) => AUTH_REASONS.has(r)))) return 'auth';
  return 'invalid';
}

async function failure(res: Response, what: string): Promise<never> {
  const { reasons, message } = await readError(res);
  const reason = reasons[0] ? ` ${reasons[0]}` : '';
  throw new CalendarProviderError(
    classifyGoogleError(res.status, reasons),
    `Google Calendar ${what} failed (${res.status}${reason})${message ? `: ${message}` : ''}`,
    res.status,
  );
}

/**
 * Event id derived from the caller's idempotency key. Google event ids use base32hex characters
 * (`a-v`, `0-9`); hex digits are a subset. Ids are never reusable once deleted, so callers change
 * the key (a new generation) to create an event again after a cancellation.
 */
export function googleEventId(requestId: string): string {
  return `erp${crypto.createHash('sha256').update(requestId).digest('hex')}`;
}

interface GoogleAttendee {
  email?: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  responseStatus?: string;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: GoogleAttendee[];
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  extendedProperties?: { private?: Record<string, string> };
}

const lc = (email: string) => email.trim().toLowerCase();

function meetLink(ev: GoogleEvent): string | null {
  return (
    ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null
  );
}

function conferenceState(ev: GoogleEvent): 'ready' | 'pending' | 'none' {
  if (meetLink(ev)) return 'ready';
  return ev.conferenceData?.createRequest?.status?.statusCode === 'pending' ? 'pending' : 'none';
}

function toResult(ev: GoogleEvent, input: CalendarEventInput): CalendarEventResult {
  if (!input.withMeeting) return { eventId: ev.id, meetingUrl: null };
  return {
    eventId: ev.id,
    meetingUrl: meetLink(ev),
    ...(conferenceState(ev) === 'pending' ? { conferencePending: true } : {}),
  };
}

const newConference = () => ({
  createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
});

const sameInstant = (a: string | undefined, b: string) => a != null && Date.parse(a) === Date.parse(b);

export interface GoogleCalendarProviderOptions {
  /** Returns a valid access token; `forceRefresh` is set once after a 401. */
  accessToken: (forceRefresh?: boolean) => Promise<string>;
  /** Defaults to the connected account's primary calendar. */
  calendarId?: string;
  /** Aborts every request (an overall budget for inline syncs). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Events live in the connected account's calendar. Attendees get Google's invitation, update and
 * cancellation emails (`sendUpdates=all`), cannot see each other or edit the event, and online
 * meetings get a Google Meet link through `conferenceData.createRequest`.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google';

  constructor(private readonly opts: GoogleCalendarProviderOptions) {}

  private url(path: string, query: Record<string, string> = {}) {
    const q = new URLSearchParams(query).toString();
    const calendar = encodeURIComponent(this.opts.calendarId ?? 'primary');
    return `${GOOGLE_CALENDAR_API}/calendars/${calendar}/events${path}${q ? `?${q}` : ''}`;
  }

  private async send(method: string, url: string, what: string, body?: unknown): Promise<Response> {
    const once = async (forceRefresh: boolean) =>
      call(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${await this.opts.accessToken(forceRefresh)}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        `Calendar ${what}`,
        this.opts,
      );
    const res = await once(false);
    if (res.status !== 401) return res;
    await drain(res);
    return once(true);
  }

  private body(input: CalendarEventInput) {
    const tz = input.timeZone;
    if (!tz) throw new CalendarProviderError('invalid', 'A time zone is required for Google Calendar events');
    const at = (wall: string) => {
      const [date, time] = wall.split('T');
      return { dateTime: zonedDateTimeToUtc(date, time, tz).toISOString(), timeZone: tz };
    };
    const attendees = new Map<string, GoogleAttendee>();
    for (const a of input.attendees)
      if (a.email)
        attendees.set(lc(a.email), { email: lc(a.email), ...(a.name ? { displayName: a.name } : {}) });
    return {
      summary: input.title,
      description: input.description ?? '',
      location: input.location ?? '',
      start: at(input.start),
      end: at(input.end),
      attendees: [...attendees.values()],
      extendedProperties: {
        private: { erpRef: input.externalRef, erpAttendees: [...attendees.keys()].join(',') },
      },
    };
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    const id = input.requestId ? googleEventId(input.requestId) : undefined;
    const res = await this.send(
      'POST',
      this.url('', { conferenceDataVersion: '1', sendUpdates: 'all' }),
      'create',
      {
        ...(id ? { id } : {}),
        ...this.body(input),
        guestsCanInviteOthers: false,
        guestsCanModify: false,
        guestsCanSeeOtherGuests: false,
        reminders: { useDefault: true },
        ...(input.withMeeting ? { conferenceData: newConference() } : {}),
      },
    );
    if (res.status === 409 && id) {
      // The id exists: a retried create that already succeeded (adopt it), or an event deleted
      // earlier (ids are never reused; `updateEvent` reports it as not found).
      await drain(res);
      return this.updateEvent(id, input);
    }
    if (!res.ok) return failure(res, 'create');
    return toResult((await res.json()) as GoogleEvent, input);
  }

  private async getEvent(eventId: string): Promise<GoogleEvent> {
    const res = await this.send('GET', this.url(`/${encodeURIComponent(eventId)}`), 'read');
    if (res.status === 404 || res.status === 410) {
      await drain(res);
      throw new CalendarProviderError('not_found', 'The Google Calendar event no longer exists', res.status);
    }
    if (!res.ok) return failure(res, 'read');
    const ev = (await res.json()) as GoogleEvent;
    if (ev.status === 'cancelled')
      throw new CalendarProviderError('not_found', 'The Google Calendar event was deleted', 410);
    return ev;
  }

  /** Patches only what changed (so retries do not resend invitations) and keeps RSVPs. */
  async updateEvent(eventId: string, input: CalendarEventInput): Promise<CalendarEventResult> {
    const existing = await this.getEvent(eventId);
    const want = this.body(input);
    const patch: Record<string, unknown> = {};
    if ((existing.summary ?? '') !== want.summary) patch.summary = want.summary;
    if ((existing.description ?? '') !== want.description) patch.description = want.description;
    if ((existing.location ?? '') !== want.location) patch.location = want.location;
    for (const key of ['start', 'end'] as const)
      if (
        !sameInstant(existing[key]?.dateTime, want[key].dateTime) ||
        existing[key]?.timeZone !== want[key].timeZone
      )
        patch[key] = want[key];

    // Attendees: add the wanted ones, drop the ones this app added before and no longer wants, and
    // keep anyone the organiser added in Google (with their responses).
    const ours = new Set(
      (existing.extendedProperties?.private?.erpAttendees ?? '').split(',').filter(Boolean),
    );
    const wanted = new Set(want.attendees.map((a) => a.email as string));
    const current = existing.attendees ?? [];
    const kept = current.filter((a) => !a.email || wanted.has(lc(a.email)) || !ours.has(lc(a.email)));
    const added = want.attendees.filter((a) => !kept.some((k) => k.email && lc(k.email) === a.email));
    if (kept.length !== current.length || added.length) patch.attendees = [...kept, ...added];
    if (patch.attendees || existing.extendedProperties?.private?.erpRef !== input.externalRef)
      patch.extendedProperties = want.extendedProperties;

    const conference = conferenceState(existing);
    if (input.withMeeting && conference === 'none') patch.conferenceData = newConference();
    if (!input.withMeeting && conference !== 'none') patch.conferenceData = null;

    if (!Object.keys(patch).length) return toResult(existing, input);
    const res = await this.send(
      'PATCH',
      this.url(`/${encodeURIComponent(eventId)}`, { conferenceDataVersion: '1', sendUpdates: 'all' }),
      'update',
      patch,
    );
    if (res.status === 404 || res.status === 410) {
      await drain(res);
      throw new CalendarProviderError('not_found', 'The Google Calendar event no longer exists', res.status);
    }
    if (!res.ok) return failure(res, 'update');
    return toResult((await res.json()) as GoogleEvent, input);
  }

  /** Deletes the event and emails attendees a cancellation; an event already gone is fine. */
  async cancelEvent(eventId: string): Promise<void> {
    const res = await this.send(
      'DELETE',
      this.url(`/${encodeURIComponent(eventId)}`, { sendUpdates: 'all' }),
      'delete',
    );
    if (res.ok || res.status === 404 || res.status === 410) {
      await drain(res);
      return;
    }
    return failure(res, 'delete');
  }

  /** Reads one upcoming event to prove the grant still works; returns the calendar's time zone. */
  async testConnection(): Promise<{ calendar: string | null; timeZone: string | null }> {
    const res = await this.send(
      'GET',
      this.url('', { maxResults: '1', singleEvents: 'true', timeMin: new Date().toISOString() }),
      'check',
    );
    if (!res.ok) return failure(res, 'check');
    const body = (await res.json()) as { summary?: string; timeZone?: string };
    return { calendar: body.summary ?? null, timeZone: body.timeZone ?? null };
  }
}

// ---------------------------------------------------------------- OAuth 2.0 (authorization code + PKCE)

export const pkceChallenge = (verifier: string) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

/** Consent URL. `prompt=consent` + `access_type=offline` make Google return a refresh token. */
export function googleAuthUrl(
  client: GoogleOAuthClient,
  p: { state: string; codeVerifier: string; loginHint?: string | null },
): string {
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: p.state,
    code_challenge: pkceChallenge(p.codeVerifier),
    code_challenge_method: 'S256',
  });
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `${GOOGLE_AUTH_URL}?${q}`;
}

export interface GoogleTokens {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  /** Only on the code exchange (and rarely on refresh when Google rotates it). */
  refreshToken: string | null;
  scopes: string[];
  idToken: string | null;
}

async function tokenRequest(form: Record<string, string>, what: string, opts?: RequestOptions) {
  const res = await call(
    GOOGLE_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    },
    `OAuth ${what}`,
    opts,
  );
  if (!res.ok) {
    const { reasons } = await readError(res);
    const reason = reasons[0] ?? 'error';
    // invalid_grant: the refresh token was revoked or expired, or the code was used or expired.
    const kind: CalendarErrorKind =
      reason === 'invalid_grant' ? 'auth' : res.status === 429 || res.status >= 500 ? 'retryable' : 'invalid';
    throw new CalendarProviderError(
      kind,
      `Google OAuth ${what} failed (${res.status} ${reason})`,
      res.status,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    id_token?: string;
  };
  if (!body.access_token)
    throw new CalendarProviderError('invalid', `Google OAuth ${what} returned no access token`);
  return {
    accessToken: body.access_token,
    expiresIn: Number(body.expires_in ?? 3600),
    refreshToken: body.refresh_token ?? null,
    scopes: (body.scope ?? '').split(' ').filter(Boolean),
    idToken: body.id_token ?? null,
  } satisfies GoogleTokens;
}

export function exchangeGoogleCode(client: GoogleOAuthClient, code: string, codeVerifier: string) {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
    },
    'code exchange',
  );
}

export function refreshGoogleToken(client: GoogleOAuthClient, refreshToken: string, opts?: RequestOptions) {
  return tokenRequest(
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    'token refresh',
    opts,
  );
}

/** Revokes the grant behind a token. A token that is already invalid counts as revoked. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await call(
      GOOGLE_REVOKE_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      },
      'OAuth revoke',
    );
    await drain(res);
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

/**
 * Checks the OAuth client credentials without a user: Google answers a made-up code with
 * `invalid_grant` when the client id and secret are valid, and `invalid_client` when not.
 */
export async function checkGoogleClient(
  client: GoogleOAuthClient,
): Promise<{ ok: boolean; message: string }> {
  try {
    await tokenRequest(
      {
        grant_type: 'authorization_code',
        code: 'erp-connection-check',
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
      },
      'client check',
    );
    return { ok: true, message: 'Google accepted the client credentials' };
  } catch (err) {
    if (err instanceof CalendarProviderError && err.kind === 'auth')
      return { ok: true, message: 'Google accepted the client ID and secret' };
    if (err instanceof CalendarProviderError && /invalid_client|unauthorized_client/.test(err.message))
      return { ok: false, message: 'Google rejected the client ID or secret' };
    return { ok: false, message: err instanceof Error ? err.message : 'Google could not be reached' };
  }
}

/**
 * Identity of the connected account from the ID token returned by the token endpoint. The token
 * comes straight from Google over TLS, so its claims are checked (audience, issuer, expiry,
 * verified email) without verifying the signature (OpenID Connect Core §3.1.3.7).
 */
export function googleIdentity(idToken: string | null, clientId: string, now = Date.now()) {
  const invalid = (why: string) =>
    new CalendarProviderError('invalid', `Google identity token rejected: ${why}`);
  if (!idToken) throw invalid('missing');
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    throw invalid('malformed');
  }
  const aud = claims.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) throw invalid('audience');
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) throw invalid('issuer');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - 60_000) throw invalid('expired');
  if (typeof claims.sub !== 'string' || !claims.sub) throw invalid('subject');
  if (typeof claims.email !== 'string' || claims.email_verified === false) throw invalid('no verified email');
  return { accountId: claims.sub, email: lc(claims.email) };
}
