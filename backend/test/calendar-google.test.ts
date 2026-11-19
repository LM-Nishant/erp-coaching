import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkGoogleClient,
  exchangeGoogleCode,
  GoogleCalendarProvider,
  googleAuthUrl,
  googleEventId,
  googleIdentity,
  GOOGLE_EVENTS_SCOPE,
  refreshGoogleToken,
  revokeGoogleToken,
  type CalendarErrorKind,
  type CalendarEventInput,
  type GoogleOAuthClient,
} from '../src/infrastructure/calendar';
import { classifyGoogleError, pkceChallenge } from '../src/infrastructure/calendar/google';
import { installFakeGoogle, type FakeAccount } from './fake-google';

const client: GoogleOAuthClient = {
  clientId: 'unit-client.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-unit-secret',
  redirectUri: 'https://api.example.test/api/calendar/public/google/callback',
};
const google = installFakeGoogle(client);
afterAll(() => google.restore());
beforeEach(() => google.reset());

const teacher: FakeAccount = { sub: '1001', email: 'teacher@example.test', timeZone: 'Asia/Kolkata' };
const MEET = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** A provider for the account; `forced` records each access-token request's forceRefresh flag. */
function providerFor(account: FakeAccount) {
  const grant = google.grant(account);
  let accessToken = grant.accessToken;
  const forced: boolean[] = [];
  const provider = new GoogleCalendarProvider({
    accessToken: async (force = false) => {
      forced.push(force);
      if (force) accessToken = (await refreshGoogleToken(client, grant.refreshToken)).accessToken;
      return accessToken;
    },
  });
  return {
    provider,
    forced,
    refreshToken: grant.refreshToken,
    expireAccessToken: () => {
      accessToken = 'ya29.expired';
    },
  };
}

const meeting = (over: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  externalRef: 'appointments:1',
  requestId: 'appointments:1:1',
  title: 'Parent-teacher meeting: Asha',
  description: 'Progress in maths',
  start: '2026-03-10T10:00',
  end: '2026-03-10T10:20',
  timeZone: 'Asia/Kolkata',
  attendees: [
    { name: 'Ms Rao', email: 'teacher@example.test' },
    { name: 'Asha Parent', email: 'Parent@Example.test' },
  ],
  withMeeting: true,
  location: null,
  ...over,
});

const later = { start: '2026-03-11T15:00', end: '2026-03-11T15:20' };

describe('GoogleCalendarProvider', () => {
  it('creates the event in the institute time zone with attendees and a Meet link', async () => {
    const { provider } = providerFor(teacher);
    const res = await provider.createEvent(meeting());
    expect(res).toEqual({ eventId: googleEventId('appointments:1:1'), meetingUrl: expect.stringMatching(MEET) });
    // Google event ids: base32hex characters (a-v, 0-9), 5 to 1024 long.
    expect(res.eventId).toMatch(/^[a-v0-9]{5,1024}$/);

    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]).toMatchObject({
      method: 'POST',
      path: '/calendar/v3/calendars/primary/events',
      query: { conferenceDataVersion: '1', sendUpdates: 'all' },
      account: teacher.email,
    });
    expect(google.calls[0].body).toMatchObject({
      id: res.eventId,
      summary: 'Parent-teacher meeting: Asha',
      description: 'Progress in maths',
      location: '',
      start: { dateTime: '2026-03-10T04:30:00.000Z', timeZone: 'Asia/Kolkata' },
      end: { dateTime: '2026-03-10T04:50:00.000Z', timeZone: 'Asia/Kolkata' },
      attendees: [
        { email: 'teacher@example.test', displayName: 'Ms Rao' },
        { email: 'parent@example.test', displayName: 'Asha Parent' },
      ],
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: false,
      reminders: { useDefault: true },
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      extendedProperties: {
        private: { erpRef: 'appointments:1', erpAttendees: 'teacher@example.test,parent@example.test' },
      },
    });
    expect(google.event(teacher.email, res.eventId)!.hangoutLink).toBe(res.meetingUrl);
  });

  it('converts wall-clock times with the zone rules of that date (DST)', async () => {
    const { provider } = providerFor(teacher);
    const ny = { timeZone: 'America/New_York', withMeeting: false };
    await provider.createEvent(
      meeting({ ...ny, requestId: 'summer', start: '2026-07-15T10:00', end: '2026-07-15T10:30' }),
    );
    await provider.createEvent(
      meeting({ ...ny, requestId: 'winter', start: '2026-01-15T10:00', end: '2026-01-15T10:30' }),
    );
    expect(google.calls.map((c) => [c.body!.start, c.body!.conferenceData])).toEqual([
      [{ dateTime: '2026-07-15T14:00:00.000Z', timeZone: 'America/New_York' }, undefined],
      [{ dateTime: '2026-01-15T15:00:00.000Z', timeZone: 'America/New_York' }, undefined],
    ]);
  });

  it('dedupes attendees by email and skips those without one', async () => {
    const { provider } = providerFor(teacher);
    const res = await provider.createEvent(
      meeting({
        withMeeting: false,
        attendees: [
          { name: 'Ms Rao', email: 'Teacher@Example.test' },
          { name: 'Ms Rao', email: ' teacher@example.test ' },
          { name: 'No email', email: null },
          { name: '', email: 'parent@example.test' },
        ],
      }),
    );
    expect(res.meetingUrl).toBeNull();
    expect(google.calls[0].body!.attendees).toEqual([
      { email: 'teacher@example.test', displayName: 'Ms Rao' },
      { email: 'parent@example.test' },
    ]);
  });

  it('refuses an event without a time zone before calling Google', async () => {
    const { provider } = providerFor(teacher);
    await expect(provider.createEvent(meeting({ timeZone: undefined }))).rejects.toMatchObject({
      kind: 'invalid',
    });
    expect(google.calls).toHaveLength(0);
  });

  it('patches only what changed and keeps RSVPs and guests added in Google', async () => {
    const { provider } = providerFor(teacher);
    const { eventId, meetingUrl } = await provider.createEvent(meeting());
    const ev = google.event(teacher.email, eventId)!;
    // The parent accepts, and the teacher invites a colleague from Google Calendar.
    ev.attendees[1].responseStatus = 'accepted';
    ev.attendees.push({ email: 'hod@example.test', responseStatus: 'needsAction' });

    google.calls.length = 0;
    const moved = await provider.updateEvent(eventId, meeting(later));
    expect(moved).toEqual({ eventId, meetingUrl });
    expect(google.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(google.calls[1].query).toEqual({ conferenceDataVersion: '1', sendUpdates: 'all' });
    expect(google.calls[1].body).toEqual({
      start: { dateTime: '2026-03-11T09:30:00.000Z', timeZone: 'Asia/Kolkata' },
      end: { dateTime: '2026-03-11T09:50:00.000Z', timeZone: 'Asia/Kolkata' },
    });
    expect(ev.attendees.map((a: { responseStatus: string }) => a.responseStatus)).toEqual([
      'needsAction',
      'accepted',
      'needsAction',
    ]);

    // A retry of the same update (or a sync with nothing new) sends nothing.
    google.calls.length = 0;
    expect(await provider.updateEvent(eventId, meeting(later))).toEqual({ eventId, meetingUrl });
    expect(google.calls.map((c) => c.method)).toEqual(['GET']);

    // Another guardian books instead: the parent this app invited is dropped, the colleague stays.
    google.calls.length = 0;
    await provider.updateEvent(
      eventId,
      meeting({
        ...later,
        attendees: [
          { name: 'Ms Rao', email: 'teacher@example.test' },
          { name: 'Asha Father', email: 'father@example.test' },
        ],
      }),
    );
    expect(google.calls[1].body).toEqual({
      attendees: [
        { email: 'teacher@example.test', displayName: 'Ms Rao', responseStatus: 'needsAction' },
        { email: 'hod@example.test', responseStatus: 'needsAction' },
        { email: 'father@example.test', displayName: 'Asha Father' },
      ],
      extendedProperties: {
        private: { erpRef: 'appointments:1', erpAttendees: 'teacher@example.test,father@example.test' },
      },
    });
  });

  it('removes and re-adds the Meet link when the meeting mode changes', async () => {
    const { provider } = providerFor(teacher);
    const { eventId } = await provider.createEvent(meeting());

    google.calls.length = 0;
    const offline = await provider.updateEvent(eventId, meeting({ withMeeting: false, location: 'Room 4' }));
    expect(offline).toEqual({ eventId, meetingUrl: null });
    expect(google.calls[1].body).toEqual({ location: 'Room 4', conferenceData: null });
    expect(google.event(teacher.email, eventId)).not.toHaveProperty('hangoutLink');

    google.calls.length = 0;
    const online = await provider.updateEvent(eventId, meeting());
    expect(google.calls[1].body).toMatchObject({
      location: '',
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    expect(online.meetingUrl).toMatch(MEET);
  });

  it('reports a Meet link Google is still creating as pending', async () => {
    const { provider } = providerFor(teacher);
    google.meetPending = true;
    const created = await provider.createEvent(meeting());
    expect(created).toEqual({ eventId: created.eventId, meetingUrl: null, conferencePending: true });

    // Reading the event again returns the finished link; nothing needs patching.
    google.calls.length = 0;
    const ready = await provider.updateEvent(created.eventId, meeting());
    expect(ready).toEqual({ eventId: created.eventId, meetingUrl: expect.stringMatching(MEET) });
    expect(google.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('adopts the event a lost create already made instead of duplicating it', async () => {
    const { provider } = providerFor(teacher);
    const first = await provider.createEvent(meeting());
    // The response was lost (timeout), so the sync retries the same request.
    google.calls.length = 0;
    const retried = await provider.createEvent(meeting());
    expect(retried).toEqual(first);
    expect(google.calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(google.eventsOf(teacher.email)).toHaveLength(1);
  });

  it('turns timeouts, network errors and Google errors into typed errors', async () => {
    const { provider } = providerFor(teacher);
    google.failNext('POST /events', 'timeout');
    await expect(provider.createEvent(meeting())).rejects.toMatchObject({
      kind: 'retryable',
      message: 'Google Calendar create request failed (timed out)',
    });
    google.failNext('POST /events', 'network');
    await expect(provider.createEvent(meeting())).rejects.toMatchObject({
      kind: 'retryable',
      message: 'Google Calendar create request failed (network error)',
    });
    google.failNext('POST /events', {
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'Rate Limit Exceeded',
          errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }],
        },
      },
    });
    await expect(provider.createEvent(meeting())).rejects.toMatchObject({
      kind: 'retryable',
      status: 403,
      message: 'Google Calendar create failed (403 rateLimitExceeded): Rate Limit Exceeded',
    });
    google.failNext('POST /events', {
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      },
    });
    await expect(provider.createEvent(meeting())).rejects.toMatchObject({ kind: 'auth', status: 403 });
    google.failNext('POST /events', {
      status: 400,
      body: { error: { code: 400, message: 'Invalid attendee email.', errors: [{ reason: 'invalid' }] } },
    });
    await expect(provider.createEvent(meeting())).rejects.toMatchObject({
      kind: 'invalid',
      message: 'Google Calendar create failed (400 invalid): Invalid attendee email.',
    });
    expect(google.eventsOf(teacher.email)).toHaveLength(0);
  });

  it.each<[number, string[], CalendarErrorKind]>([
    [404, ['notFound'], 'not_found'],
    [410, ['deleted'], 'not_found'],
    [429, ['rateLimitExceeded'], 'retryable'],
    [500, ['backendError'], 'retryable'],
    [503, [], 'retryable'],
    [403, ['userRateLimitExceeded'], 'retryable'],
    [403, ['quotaExceeded'], 'retryable'],
    [401, ['authError'], 'auth'],
    [403, ['insufficientPermissions'], 'auth'],
    [403, ['forbidden'], 'auth'],
    [403, ['forbiddenForNonOrganizer'], 'invalid'],
    [400, ['badRequest'], 'invalid'],
  ])('classifies %i %j as %s', (status, reasons, kind) => {
    expect(classifyGoogleError(status, reasons)).toBe(kind);
  });

  it('cancels idempotently, and a deleted event is not found afterwards', async () => {
    const { provider } = providerFor(teacher);
    const { eventId } = await provider.createEvent(meeting());
    await provider.cancelEvent(eventId);
    await provider.cancelEvent(eventId);
    await provider.cancelEvent(googleEventId('never-created'));
    const deletes = google.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.query)).toEqual(Array(3).fill({ sendUpdates: 'all' }));
    expect(google.event(teacher.email, eventId)!.status).toBe('cancelled');

    await expect(provider.updateEvent(eventId, meeting())).rejects.toMatchObject({ kind: 'not_found' });
    // Google never reuses a deleted id, so the same request id cannot create it again.
    await expect(provider.createEvent(meeting())).rejects.toMatchObject({ kind: 'not_found' });

    google.failNext('DELETE /events/', { status: 503, body: { error: { code: 503, message: 'Backend Error' } } });
    await expect(provider.cancelEvent(eventId)).rejects.toMatchObject({ kind: 'retryable', status: 503 });
  });

  it('refreshes the access token once after a 401 and reports a revoked grant as auth', async () => {
    const p = providerFor(teacher);
    const { eventId } = await p.provider.createEvent(meeting());
    p.expireAccessToken();
    p.forced.length = 0;
    google.calls.length = 0;
    await p.provider.cancelEvent(eventId);
    expect(p.forced).toEqual([false, true]);
    expect(google.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE /calendar/v3/calendars/primary/events/${eventId}`,
      'POST /token',
      `DELETE /calendar/v3/calendars/primary/events/${eventId}`,
    ]);

    google.revokeAccount(teacher.email);
    const err = await p.provider.updateEvent(eventId, meeting()).catch((e: Error) => e);
    expect(err).toMatchObject({ kind: 'auth', message: 'Google OAuth token refresh failed (400 invalid_grant)' });
    expect((err as Error).message).not.toContain(p.refreshToken);
  });

  it('reads the calendar name and time zone for the connection check', async () => {
    const { provider } = providerFor(teacher);
    expect(await provider.testConnection()).toEqual({ calendar: teacher.email, timeZone: 'Asia/Kolkata' });
    expect(google.calls[0]).toMatchObject({
      method: 'GET',
      path: '/calendar/v3/calendars/primary/events',
      query: { maxResults: '1', singleEvents: 'true' },
    });
  });
});

describe('Google OAuth helpers', () => {
  it('builds the consent URL for offline access with PKCE (S256)', () => {
    // RFC 7636 appendix B.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const verifier = 'v'.repeat(64);
    const url = new URL(
      googleAuthUrl(client, { state: 's'.repeat(43), codeVerifier: verifier, loginHint: teacher.email }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope: `openid email ${GOOGLE_EVENTS_SCOPE}`,
      access_type: 'offline',
      prompt: 'consent',
      state: 's'.repeat(43),
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      login_hint: teacher.email,
    });
    expect(googleAuthUrl(client, { state: 'x', codeVerifier: verifier })).not.toContain('login_hint');
  });

  it('exchanges a code once, only with its verifier and the right client', async () => {
    const verifier = 'a'.repeat(64);
    const consent = googleAuthUrl(client, { state: 'state-1', codeVerifier: verifier });
    const code = new URL(google.consent(consent, teacher), 'https://api.example.test').searchParams.get('code')!;

    await expect(exchangeGoogleCode(client, code, 'b'.repeat(64))).rejects.toMatchObject({
      kind: 'auth',
      message: 'Google OAuth code exchange failed (400 invalid_grant)',
    });
    await expect(
      exchangeGoogleCode({ ...client, clientSecret: 'wrong' }, code, verifier),
    ).rejects.toMatchObject({ kind: 'invalid', message: 'Google OAuth code exchange failed (401 invalid_client)' });

    const tokens = await exchangeGoogleCode(client, code, verifier);
    expect(tokens).toEqual({
      accessToken: expect.any(String),
      expiresIn: 3599,
      refreshToken: google.refreshTokensOf(teacher.email)[0],
      scopes: ['openid', 'email', GOOGLE_EVENTS_SCOPE],
      idToken: expect.any(String),
    });
    expect(googleIdentity(tokens.idToken, client.clientId)).toEqual({ accountId: '1001', email: teacher.email });
    expect(google.calls.at(-1)!.body).toEqual({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
    });

    // Codes are single-use.
    await expect(exchangeGoogleCode(client, code, verifier)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('refreshes, follows a rotated refresh token and stops after a revoke', async () => {
    const { refreshToken } = google.grant(teacher);
    expect((await refreshGoogleToken(client, refreshToken)).refreshToken).toBeNull();
    expect(google.calls[0].body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });

    google.rotateRefreshTokens = true;
    const rotated = (await refreshGoogleToken(client, refreshToken)).refreshToken!;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(refreshToken);
    await expect(refreshGoogleToken(client, refreshToken)).rejects.toMatchObject({ kind: 'auth' });

    expect(await revokeGoogleToken(rotated)).toBe(true);
    expect(google.revokes).toEqual([teacher.email]);
    await expect(refreshGoogleToken(client, rotated)).rejects.toMatchObject({ kind: 'auth' });
    // Google answers 400 for a token it no longer knows: still revoked.
    expect(await revokeGoogleToken(rotated)).toBe(true);
    google.failNext('POST /revoke', 'network');
    expect(await revokeGoogleToken(rotated)).toBe(false);

    google.failNext('POST /token', { status: 503, body: { error: 'temporarily_unavailable' } });
    await expect(refreshGoogleToken(client, rotated)).rejects.toMatchObject({ kind: 'retryable' });
  });

  it('checks the OAuth client credentials without a user', async () => {
    expect(await checkGoogleClient(client)).toEqual({
      ok: true,
      message: 'Google accepted the client ID and secret',
    });
    expect(google.calls[0].body).not.toHaveProperty('code_verifier');
    expect(await checkGoogleClient({ ...client, clientSecret: 'wrong' })).toEqual({
      ok: false,
      message: 'Google rejected the client ID or secret',
    });
    google.failNext('POST /token', 'network');
    expect(await checkGoogleClient(client)).toEqual({
      ok: false,
      message: 'Google OAuth client check request failed (network error)',
    });
  });

  describe('googleIdentity', () => {
    const now = Date.parse('2026-03-10T00:00:00Z');
    const jwt = (claims: unknown) =>
      `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
    const base = {
      iss: 'https://accounts.google.com',
      aud: client.clientId,
      sub: '42',
      email: 'Teacher@Example.test',
      email_verified: true,
      exp: now / 1000 + 600,
    };

    it.each<[string, string | null]>([
      ['missing', null],
      ['malformed', 'not-a-jwt'],
      ['malformed', jwt(null)],
      ['audience', jwt({ ...base, aud: 'someone-else.apps.googleusercontent.com' })],
      ['issuer', jwt({ ...base, iss: 'https://accounts.example.test' })],
      ['expired', jwt({ ...base, exp: now / 1000 - 120 })],
      ['subject', jwt({ ...base, sub: '' })],
      ['no verified email', jwt({ ...base, email_verified: false })],
      ['no verified email', jwt({ ...base, email: undefined })],
    ])('rejects a token: %s', (why, token) => {
      expect(() => googleIdentity(token, client.clientId, now)).toThrow(`Google identity token rejected: ${why}`);
    });

    it('accepts an audience list, the short issuer and a little clock skew', () => {
      const token = jwt({ ...base, aud: ['other', client.clientId], iss: 'accounts.google.com', exp: now / 1000 - 30 });
      expect(googleIdentity(token, client.clientId, now)).toEqual({ accountId: '42', email: 'teacher@example.test' });
    });
  });
});
