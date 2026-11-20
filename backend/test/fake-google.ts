import crypto from 'node:crypto';
import { vi } from 'vitest';

/**
 * In-memory Google for tests: the OAuth 2.0 token and revoke endpoints and the Calendar API v3
 * events resource, installed as a `fetch` spy at the adapter boundary. Requests to Google hosts are
 * answered here; everything else goes to the real `fetch`. No live Google calls in tests or CI.
 */

export interface FakeAccount {
  /** Google's stable account id (the ID token's `sub`). */
  sub: string;
  email: string;
  /** The primary calendar's time zone (reported by the connection check). */
  timeZone?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed Google JSON, read freely in tests
type Json = Record<string, any>;

export interface FakeCall {
  method: string;
  /** e.g. `/token` or `/calendar/v3/calendars/primary/events/<id>`. */
  path: string;
  query: Record<string, string>;
  /** JSON or form body. */
  body: Json | null;
  /** The account whose access token was sent (Calendar API calls). */
  account: string | null;
}

export type FakeFailure = { status: number; body?: unknown } | 'network' | 'timeout';

type FakeEvent = Json & { id: string; status: string };

interface AuthCode {
  account: FakeAccount;
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  noRefresh: boolean;
  used: boolean;
}

const GOOGLE_HOST = /(^|\.)google(apis)?\.com$/;
const EVENTS_PATH = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const oauthError = (status: number, error: string, description: string) =>
  json(status, { error, error_description: description });
const apiError = (status: number, reason: string, message: string, statusName?: string) =>
  json(status, {
    error: {
      code: status,
      message,
      errors: [{ domain: 'global', reason, message }],
      ...(statusName ? { status: statusName } : {}),
    },
  });

const opaque = (prefix: string) => `${prefix}${crypto.randomBytes(18).toString('base64url')}`;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const challengeOf = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');
const meetCode = () => {
  const s = crypto
    .randomBytes(8)
    .toString('hex')
    .replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]);
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7, 10)}`;
};

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === 'string' ? input : input.url);
}

function bodyOf(init: RequestInit | undefined): Json | null {
  if (typeof init?.body !== 'string') return null;
  const contentType = new Headers(init.headers).get('content-type') ?? '';
  if (contentType.includes('application/json')) return JSON.parse(init.body) as Json;
  return Object.fromEntries(new URLSearchParams(init.body));
}

export function installFakeGoogle(client: { clientId: string; clientSecret: string }) {
  const realFetch = globalThis.fetch;
  const accounts = new Map<string, FakeAccount>();
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, { sub: string; scopes: string[] }>();
  const codes = new Map<string, AuthCode>();
  const calendars = new Map<string, Map<string, FakeEvent>>();
  const pendingConferences = new Set<FakeEvent>();
  const failures: { method: string; path: string; failure: FakeFailure }[] = [];

  const fake = {
    /** Every request that reached the fake Google, in order. */
    calls: [] as FakeCall[],
    /** Emails of accounts whose grant was revoked through the revoke endpoint. */
    revokes: [] as string[],
    /** Google URLs this fake does not implement. */
    unknown: [] as string[],
    /** New Meet links stay pending until the event is read again. */
    meetPending: false,
    /** Token refreshes return a new refresh token and invalidate the old one. */
    rotateRefreshTokens: false,

    /** The user approves the consent screen; returns the callback path and query to open. */
    consent(authUrl: string, account: FakeAccount, opts: { scopes?: string[]; noRefresh?: boolean } = {}) {
      const q = new URL(authUrl).searchParams;
      if (q.get('client_id') !== client.clientId) throw new Error('consent: unknown client_id');
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256')
        throw new Error('consent: expected the code flow with PKCE (S256)');
      const scopes = opts.scopes ?? (q.get('scope') ?? '').split(' ').filter(Boolean);
      const code = opaque('4/0fake-');
      codes.set(code, {
        account,
        clientId: client.clientId,
        redirectUri: q.get('redirect_uri') ?? '',
        challenge: q.get('code_challenge') ?? '',
        scopes,
        noRefresh: Boolean(opts.noRefresh) || q.get('access_type') !== 'offline',
        used: false,
      });
      const back = new URL(q.get('redirect_uri') ?? '');
      back.search = new URLSearchParams({
        state: q.get('state') ?? '',
        code,
        scope: scopes.join(' '),
        authuser: '0',
        prompt: 'consent',
      }).toString();
      return `${back.pathname}${back.search}`;
    },

    /** The user declines the consent screen. */
    deny(authUrl: string) {
      const q = new URL(authUrl).searchParams;
      const back = new URL(q.get('redirect_uri') ?? '');
      back.search = new URLSearchParams({ error: 'access_denied', state: q.get('state') ?? '' }).toString();
      return `${back.pathname}${back.search}`;
    },

    /** Tokens for an account without going through consent (provider-level tests). */
    grant(
      account: FakeAccount,
      scopes = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
    ) {
      accounts.set(account.sub, account);
      const refreshToken = opaque('1//fake-');
      refreshTokens.set(refreshToken, { sub: account.sub, scopes });
      return { accessToken: issueAccess(account.sub), refreshToken };
    },

    /** Refresh tokens currently valid for the account. */
    refreshTokensOf(email: string) {
      return [...refreshTokens]
        .filter(([, t]) => accounts.get(t.sub)?.email === email)
        .map(([token]) => token);
    },

    /** The user removes the app's access in their Google Account (or an admin does). */
    revokeAccount(email: string) {
      for (const a of accounts.values()) if (a.email === email) endGrant(a.sub);
    },

    /** Fails the next request whose method matches and whose path contains `path`. */
    failNext(match: string, failure: FakeFailure) {
      const [method, path] = match.split(' ');
      failures.push({ method, path, failure });
    },

    eventsOf(email: string): FakeEvent[] {
      const sub = [...accounts.values()].find((a) => a.email === email)?.sub;
      return sub ? [...(calendars.get(sub)?.values() ?? [])] : [];
    },

    event(email: string, id: string): FakeEvent | undefined {
      return fake.eventsOf(email).find((e) => e.id === id);
    },

    /** Forgets everything (accounts, tokens, events, queued failures and recorded calls). */
    reset() {
      for (const m of [accounts, accessTokens, refreshTokens, codes, calendars]) m.clear();
      pendingConferences.clear();
      failures.length = 0;
      fake.calls.length = 0;
      fake.revokes.length = 0;
      fake.unknown.length = 0;
      fake.meetPending = false;
      fake.rotateRefreshTokens = false;
    },

    restore() {
      spy.mockRestore();
    },
  };

  function issueAccess(sub: string) {
    const token = opaque('ya29.fake-');
    accessTokens.set(token, sub);
    return token;
  }

  /** Revoking any token ends the account's whole grant to the client. */
  function endGrant(sub: string) {
    for (const [t, s] of accessTokens) if (s === sub) accessTokens.delete(t);
    for (const [t, r] of refreshTokens) if (r.sub === sub) refreshTokens.delete(t);
  }

  function idToken(account: FakeAccount) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'https://accounts.google.com',
      azp: client.clientId,
      aud: client.clientId,
      sub: account.sub,
      email: account.email,
      email_verified: true,
      iat: now,
      exp: now + 3600,
    };
    return `${b64({ alg: 'RS256', kid: 'fake', typ: 'JWT' })}.${b64(claims)}.fake-signature`;
  }

  function token(form: Json): Response {
    if (form.client_id !== client.clientId || form.client_secret !== client.clientSecret)
      return oauthError(401, 'invalid_client', 'Unauthorized');
    if (form.grant_type === 'authorization_code') {
      const code = codes.get(String(form.code ?? ''));
      if (!code || code.used) return oauthError(400, 'invalid_grant', 'Malformed auth code.');
      if (form.redirect_uri !== code.redirectUri)
        return oauthError(400, 'redirect_uri_mismatch', 'Bad Request');
      if (challengeOf(String(form.code_verifier ?? '')) !== code.challenge)
        return oauthError(400, 'invalid_grant', 'Invalid code verifier.');
      code.used = true;
      accounts.set(code.account.sub, code.account);
      const refreshToken = code.noRefresh ? null : opaque('1//fake-');
      if (refreshToken) refreshTokens.set(refreshToken, { sub: code.account.sub, scopes: code.scopes });
      return json(200, {
        access_token: issueAccess(code.account.sub),
        expires_in: 3599,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        scope: code.scopes.join(' '),
        token_type: 'Bearer',
        id_token: idToken(code.account),
      });
    }
    if (form.grant_type === 'refresh_token') {
      const current = refreshTokens.get(String(form.refresh_token ?? ''));
      if (!current) return oauthError(400, 'invalid_grant', 'Token has been expired or revoked.');
      let rotated: string | null = null;
      if (fake.rotateRefreshTokens) {
        refreshTokens.delete(String(form.refresh_token));
        rotated = opaque('1//fake-');
        refreshTokens.set(rotated, current);
      }
      return json(200, {
        access_token: issueAccess(current.sub),
        expires_in: 3599,
        scope: current.scopes.join(' '),
        token_type: 'Bearer',
        ...(rotated ? { refresh_token: rotated } : {}),
      });
    }
    return oauthError(400, 'unsupported_grant_type', 'Invalid grant_type');
  }

  function revoke(form: Json): Response {
    const t = String(form.token ?? '');
    const sub = refreshTokens.get(t)?.sub ?? accessTokens.get(t);
    if (!sub) return oauthError(400, 'invalid_token', 'Token expired or revoked');
    endGrant(sub);
    fake.revokes.push(accounts.get(sub)?.email ?? sub);
    return json(200, {});
  }

  function addConference(ev: FakeEvent, request: Json) {
    if (fake.meetPending) {
      ev.conferenceData = { createRequest: { ...request, status: { statusCode: 'pending' } } };
      delete ev.hangoutLink;
      pendingConferences.add(ev);
      return;
    }
    const code = meetCode();
    ev.hangoutLink = `https://meet.google.com/${code}`;
    ev.conferenceData = {
      createRequest: { ...request, status: { statusCode: 'success' } },
      entryPoints: [{ entryPointType: 'video', uri: ev.hangoutLink, label: `meet.google.com/${code}` }],
      conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
      conferenceId: code,
    };
    pendingConferences.delete(ev);
  }

  const withResponses = (attendees: Json[] | undefined) =>
    (attendees ?? []).map((a) => ({ ...a, responseStatus: a.responseStatus ?? 'needsAction' }));

  function calendarApi(method: string, url: URL, init: RequestInit | undefined, call: FakeCall): Response {
    const m = EVENTS_PATH.exec(url.pathname);
    if (!m) return apiError(404, 'notFound', 'Not Found');
    const bearer = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
    const sub = accessTokens.get(bearer);
    if (!sub)
      return apiError(401, 'authError', 'Request had invalid authentication credentials.', 'UNAUTHENTICATED');
    const account = accounts.get(sub)!;
    call.account = account.email;
    if (decodeURIComponent(m[1]) !== 'primary') return apiError(404, 'notFound', 'Not Found');
    const calendar = calendars.get(sub) ?? new Map<string, FakeEvent>();
    calendars.set(sub, calendar);
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    const conferences = url.searchParams.get('conferenceDataVersion') === '1';
    const body = call.body ?? {};

    if (!id && method === 'GET')
      return json(200, {
        kind: 'calendar#events',
        summary: account.email,
        timeZone: account.timeZone ?? 'UTC',
        items: [...calendar.values()].filter((e) => e.status !== 'cancelled').slice(0, 1),
      });

    if (!id && method === 'POST') {
      if (body.id && calendar.has(body.id))
        return apiError(409, 'duplicate', 'The requested identifier already exists.');
      const { conferenceData, ...fields } = body;
      const ev: FakeEvent = {
        kind: 'calendar#event',
        id: body.id ?? crypto.randomBytes(13).toString('hex'),
        status: 'confirmed',
        htmlLink: 'https://www.google.com/calendar/event?eid=fake',
        organizer: { email: account.email, self: true },
        creator: { email: account.email, self: true },
        sequence: 0,
        ...fields,
        attendees: withResponses(fields.attendees),
      };
      if (conferences && conferenceData?.createRequest) addConference(ev, conferenceData.createRequest);
      calendar.set(ev.id, ev);
      return json(200, ev);
    }

    const ev = id ? calendar.get(id) : undefined;
    if (!ev) return apiError(404, 'notFound', 'Not Found');

    if (method === 'GET') {
      if (pendingConferences.has(ev)) {
        // Google finishes creating the Meet link shortly after the event.
        const pending = fake.meetPending;
        fake.meetPending = false;
        addConference(ev, ev.conferenceData.createRequest);
        fake.meetPending = pending;
      }
      return json(200, ev);
    }
    if (ev.status === 'cancelled') return apiError(410, 'deleted', 'Resource has been deleted');

    if (method === 'PATCH') {
      for (const [key, value] of Object.entries(body)) {
        if (key === 'conferenceData') {
          if (!conferences) continue;
          if (value === null) {
            delete ev.conferenceData;
            delete ev.hangoutLink;
            pendingConferences.delete(ev);
          } else if (value.createRequest) addConference(ev, value.createRequest);
        } else if (value === null) delete ev[key];
        else ev[key] = key === 'attendees' ? withResponses(value) : value;
      }
      ev.sequence += 1;
      return json(200, ev);
    }
    if (method === 'DELETE') {
      ev.status = 'cancelled';
      pendingConferences.delete(ev);
      return new Response(null, { status: 204 });
    }
    return apiError(405, 'methodNotAllowed', 'Method Not Allowed');
  }

  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: FetchInput, init?: RequestInit) => {
      const url = urlOf(input);
      if (!GOOGLE_HOST.test(url.hostname)) return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      const call: FakeCall = {
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: bodyOf(init),
        account: null,
      };
      fake.calls.push(call);
      const i = failures.findIndex((f) => f.method === method && url.pathname.includes(f.path));
      if (i >= 0) {
        const [{ failure }] = failures.splice(i, 1);
        if (failure === 'network') throw new TypeError('fetch failed');
        if (failure === 'timeout')
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        return json(failure.status, failure.body ?? {});
      }
      if (url.hostname === 'oauth2.googleapis.com' && method === 'POST') {
        if (url.pathname === '/token') return token(call.body ?? {});
        if (url.pathname === '/revoke') return revoke(call.body ?? {});
      }
      if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/calendar/v3/'))
        return calendarApi(method, url, init, call);
      fake.unknown.push(`${method} ${url.href}`);
      return json(404, { error: 'not_found' });
    });

  return fake;
}

export type FakeGoogle = ReturnType<typeof installFakeGoogle>;
