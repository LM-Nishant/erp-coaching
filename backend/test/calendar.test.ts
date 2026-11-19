import request from 'supertest';
import { Op } from 'sequelize';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/infrastructure/config';
import { decryptSecret, sha256 } from '../src/infrastructure/crypto';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { Job } from '../src/infrastructure/jobs/job.model';
import { redactUrl } from '../src/infrastructure/logger';
import { runWithContext } from '../src/shared/context';
import { getInstituteTimezone, zonedDateTimeToUtc } from '../src/shared/timezone';
import { Branch } from '../src/modules/branches/branch.model';
import { Appointment } from '../src/modules/appointments/appointments.models';
import {
  CalendarConnection,
  CalendarEventLink,
  CalendarOAuthState,
} from '../src/modules/calendar/calendar.models';
import { resetCalendarAccessTokens } from '../src/modules/calendar/google-account';
import { installFakeGoogle, type FakeAccount } from './fake-google';
import {
  USERS,
  bearer,
  getApp,
  idWatermarks,
  lastOtpFor,
  login,
  newDevice,
  purgeCreatedSince,
} from './helpers';

/**
 * Google Calendar end to end against the in-memory Google (test/fake-google.ts): the consent flow,
 * appointment events with Meet links, background retries, the organiser fallback, revoked grants,
 * tenant isolation and disconnecting. No request leaves the process.
 */

let seq = 0;
const mobile = () => `953${String(seq++).padStart(7, '0')}`;
const RUN = Date.now().toString(36);
const CLIENT_ID = `gcal-test-${RUN}.apps.googleusercontent.com`;
const CLIENT_SECRET = `GOCSPX-test-${RUN}`;
const PASSWORD = 'Password@123';
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const RECONNECT = 'Reconnect Google Calendar to sync this event';

const T1: FakeAccount = { sub: `1001${RUN}`, email: `gcal.t1.${RUN}@example.com`, timeZone: 'Asia/Kolkata' };
const T2: FakeAccount = { sub: `1002${RUN}`, email: `gcal.t2.${RUN}@example.com` };
const OFFICE: FakeAccount = { sub: `1003${RUN}`, email: `gcal.office.${RUN}@example.com` };
const PARENT_EMAIL = `gcal.parent.${RUN}@example.com`;

const CREATED_TABLES = [
  'calendar_events',
  'calendar_oauth_states',
  'calendar_connections',
  'appointment_events',
  'appointments',
  'notification_messages',
  'jobs',
  'students',
  'guardians',
  'users',
] as const;

const daysAhead = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const asApex = <T>(fn: () => Promise<T>) =>
  runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, fn);
const cookieOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])[0] ?? '';

describe('Google Calendar', () => {
  const saved = {
    provider: config.CALENDAR_PROVIDER,
    clientId: config.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
  };
  const fake = installFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  let marks: Record<string, number>;
  let app: Awaited<ReturnType<typeof getApp>>;
  let superAdmin: string;
  let admin: string;
  let zenith: string;
  let t1: string;
  let t2: string;
  let parent: string;
  let t1Id: number;
  let t2Id: number;
  let parentUserId: number;
  let branchId: number;
  let tz: string;
  let child: { id: number; userId: number };

  const useGoogle = () => {
    config.CALENDAR_PROVIDER = 'google';
    config.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
    config.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
  };

  async function teacher(name: string, email: string) {
    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const role = roles.body.find((r: { slug: string }) => r.slug === 'teacher');
    const m = mobile();
    const res = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({
        name,
        mobile: m,
        password: PASSWORD,
        email,
        roles: [{ roleId: role.id, branchId: null }],
        branchIds: [branchId],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as number, token: (await login({ mobile: m, password: PASSWORD })).accessToken };
  }

  async function otpLogin(m: string) {
    const device = newDevice();
    const ch = await request(app).post('/api/auth/otp/request').send({ mobile: m, device });
    const res = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: ch.body.challengeId, code: lastOtpFor(m), device });
    expect(res.body.status).toBe('authenticated');
    return res.body.accessToken as string;
  }

  /** A parent's request, as the booking flow stores it (approving it is what reaches Google). */
  async function requestMeeting(teacherUserId: number, date: string, startTime = '10:00', endTime = '10:30') {
    const a = await asApex(() =>
      Appointment.create({
        instituteId: 1,
        branchId,
        slotId: null,
        teacherUserId,
        requestedByUserId: parentUserId,
        studentId: child.id,
        studentUserId: child.userId,
        date,
        startTime,
        endTime,
        mode: 'online',
        status: 'requested',
        agenda: 'Discuss progress',
      }),
    );
    return a.id;
  }

  const approve = (token: string, id: number, body: Record<string, unknown> = {}) =>
    request(app).post(`/api/appointments/${id}/approve`).set(bearer(token)).send(body);
  const syncOf = async (id: number) =>
    (await request(app).get(`/api/appointments/${id}`).set(bearer(admin))).body.calendarSync;
  const linkOf = async (id: number) =>
    (
      await asApex(() =>
        CalendarEventLink.findOne({ where: { instituteId: 1, source: 'appointments', sourceId: id } }),
      )
    )?.get({ plain: true });
  const appointment = (id: number) => asApex(() => Appointment.findOne({ where: { instituteId: 1, id } }));
  const connectionOf = async (userId: number | null) =>
    (
      await CalendarConnection.findOne({ where: { instituteId: 1, userId }, tenantBypass: true } as object)
    )?.get({ plain: true }) ?? null;
  const stateRow = async (state: string) =>
    (
      await CalendarOAuthState.findOne({ where: { stateHash: sha256(state) }, tenantBypass: true } as object)
    )?.get({ plain: true });
  const tokenCalls = () => fake.calls.filter((c) => c.path === '/token');
  const at = (date: string, time: string) => zonedDateTimeToUtc(date, time, tz).toISOString();

  /** Runs queued calendar syncs now (retries and Meet checks are scheduled seconds ahead). */
  async function runCalendarJobs() {
    await Job.update(
      { runAt: new Date(Date.now() - 1000) },
      { where: { name: 'calendar.sync', status: 'pending', id: { [Op.gt]: marks.jobs } } },
    );
    await processDueJobs(100);
  }

  /** Gets a start link and opens it: the browser now holds the flow's cookie and is at Google. */
  async function begin(token: string, path: string, client: 'web' | 'native' = 'web') {
    const res = await request(app).post(path).set(bearer(token)).send({ client });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const startUrl = new URL(res.body.startUrl);
    const start = `${startUrl.pathname}${startUrl.search}`;
    const opened = await request(app).get(start);
    expect(opened.status, opened.text).toBe(302);
    return {
      state: startUrl.searchParams.get('state')!,
      startUrl,
      start,
      opened,
      google: opened.headers.location as string,
      cookie: cookieOf(opened).split(';')[0],
    };
  }

  beforeAll(async () => {
    app = await getApp();
    marks = await idWatermarks(CREATED_TABLES);
    superAdmin = (await login(USERS.superAdmin)).accessToken;
    admin = (await login(USERS.apexAdmin)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    tz = await asApex(() => getInstituteTimezone(1));

    ({ id: t1Id, token: t1 } = await teacher('Gcal Teacher One', T1.email));
    ({ id: t2Id, token: t2 } = await teacher('Gcal Teacher Two', T2.email));
    const s = await request(app)
      .post('/api/students')
      .set(bearer(admin))
      .send({ name: 'Gcal Child', mobile: mobile() });
    expect(s.status).toBe(201);
    child = s.body;
    const pm = mobile();
    const g = await request(app)
      .post(`/api/students/${child.id}/guardians`)
      .set(bearer(admin))
      .send({ name: 'Gcal Parent', mobile: pm, relation: 'mother', email: PARENT_EMAIL });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    parentUserId = g.body.userId;
    parent = await otpLogin(pm);
    useGoogle();
  });

  // Every Google request the API made is one this fake implements (no silent real-network calls).
  afterEach(() => expect(fake.unknown).toEqual([]));

  afterAll(async () => {
    config.CALENDAR_PROVIDER = saved.provider;
    config.GOOGLE_OAUTH_CLIENT_ID = saved.clientId;
    config.GOOGLE_OAUTH_CLIENT_SECRET = saved.clientSecret;
    fake.restore();
    resetCalendarAccessTokens();
    await purgeCreatedSince(marks);
  });

  // ------------------------------------------------------------ platform client

  it('shows super admins what to register in Google Cloud, and checks the OAuth client', async () => {
    config.CALENDAR_PROVIDER = 'mock';
    try {
      const off = await request(app).get('/api/admin/calendar').set(bearer(superAdmin));
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ provider: 'mock', configured: false });
      const offTest = await request(app).post('/api/admin/calendar/test').set(bearer(superAdmin));
      expect(offTest.body).toEqual({ ok: false, message: expect.stringContaining('CALENDAR_PROVIDER=mock') });
      // The mock stays the default: nothing can be connected and Google is never called.
      const refused = await request(app).post('/api/calendar/me/connect').set(bearer(t1)).send({});
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('CALENDAR_NOT_CONFIGURED');
      expect(fake.calls).toHaveLength(0);
    } finally {
      useGoogle();
    }

    const on = await request(app).get('/api/admin/calendar').set(bearer(superAdmin));
    expect(on.body).toMatchObject({
      provider: 'google',
      configured: true,
      clientId: CLIENT_ID,
      redirectUri: config.googleOAuthRedirectUri,
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
      connections: { active: expect.any(Number), needsReconnect: expect.any(Number) },
    });
    expect(on.body.redirectUri).toMatch(/\/api\/calendar\/public\/google\/callback$/);
    expect(JSON.stringify(on.body)).not.toContain(CLIENT_SECRET);

    const ok = await request(app).post('/api/admin/calendar/test').set(bearer(superAdmin));
    expect(ok.body).toEqual({ ok: true, message: 'Google accepted the client ID and secret' });
    config.GOOGLE_OAUTH_CLIENT_SECRET = 'GOCSPX-wrong';
    try {
      const bad = await request(app).post('/api/admin/calendar/test').set(bearer(superAdmin));
      expect(bad.body).toEqual({ ok: false, message: 'Google rejected the client ID or secret' });
    } finally {
      useGoogle();
    }

    expect((await request(app).get('/api/admin/calendar').set(bearer(admin))).status).toBe(403);
    expect((await request(app).post('/api/calendar/organiser/connect').set(bearer(t1)).send({})).status).toBe(
      403,
    );
    expect((await request(app).post('/api/calendar/me/connect').set(bearer(parent)).send({})).status).toBe(
      403,
    );
  });

  // ------------------------------------------------------------ consent

  it("connects a teacher's own calendar: single-use state, PKCE and a browser-bound callback", async () => {
    const earlier = tokenCalls().length;
    const exchanges = () => tokenCalls().slice(earlier);
    const flow = await begin(t1, '/api/calendar/me/connect');
    expect(`${flow.startUrl.origin}${flow.startUrl.pathname}`).toBe(
      `${config.API_PUBLIC_URL.replace(/\/+$/, '')}/api/calendar/public/google/start`,
    );
    expect(flow.opened.headers['cache-control']).toBe('no-store');
    const google = new URL(flow.google);
    expect(`${google.origin}${google.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(google.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: config.googleOAuthRedirectUri,
      response_type: 'code',
      access_type: 'offline',
      code_challenge_method: 'S256',
      state: flow.state,
      login_hint: T1.email,
    });
    expect(google.searchParams.get('scope')?.split(' ')).toContain(
      'https://www.googleapis.com/auth/calendar.events',
    );
    const setCookie = cookieOf(flow.opened);
    expect(setCookie).toMatch(/^erp_gcal_[0-9a-f]{16}=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\/api\/calendar\/public\/google/);
    expect(setCookie).toMatch(/Max-Age=600/);

    // The link works again only in the browser that opened it.
    const elsewhere = await request(app).get(flow.start);
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.headers['content-security-policy']).toBe(PAGE_CSP);
    expect((await request(app).get(flow.start).set('Cookie', flow.cookie)).status).toBe(302);

    const back = fake.consent(flow.google, T1);
    expect(back.startsWith('/api/calendar/public/google/callback?')).toBe(true);
    const stolen = await request(app).get(back);
    expect(stolen.status).toBe(400);
    expect(stolen.text).toContain('Use the same browser');
    expect(exchanges()).toHaveLength(0);
    expect((await stateRow(flow.state))!.usedAt).toBeNull();

    const done = await request(app).get(back).set('Cookie', flow.cookie);
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe(`${config.publicWebUrl}/appointments/availability?calendar=connected`);
    expect(cookieOf(done)).toMatch(/^erp_gcal_[0-9a-f]{16}=;.*Expires=Thu, 01 Jan 1970/);
    expect(exchanges()).toHaveLength(1);
    expect(exchanges()[0].body).toMatchObject({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: config.googleOAuthRedirectUri,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/),
    });

    const conn = (await connectionOf(t1Id))!;
    expect(conn).toMatchObject({
      accountId: T1.sub,
      accountEmail: T1.email,
      status: 'active',
      connectedByUserId: t1Id,
    });
    const [refreshToken] = fake.refreshTokensOf(T1.email);
    expect(conn.refreshTokenEncrypted).not.toContain(refreshToken);
    expect(decryptSecret(conn.refreshTokenEncrypted)).toBe(refreshToken);
    const used = (await stateRow(flow.state))!;
    expect(used).toMatchObject({ result: 'connected', codeVerifierEncrypted: '' });
    expect(used.usedAt).toBeInstanceOf(Date);

    // Replaying the callback shows the result again without another code exchange; the start link is spent.
    const replay = await request(app).get(back).set('Cookie', flow.cookie);
    expect(replay.headers.location).toBe(done.headers.location);
    expect(exchanges()).toHaveLength(1);
    expect((await request(app).get(flow.start).set('Cookie', flow.cookie)).status).toBe(410);

    const me = await request(app).get('/api/calendar/me').set(bearer(t1));
    expect(me.body).toMatchObject({
      provider: 'google',
      configured: true,
      connection: { userId: t1Id, accountEmail: T1.email, status: 'active' },
      organiserConnected: false,
    });
    expect(JSON.stringify(me.body)).not.toContain(refreshToken);
    expect(JSON.stringify(me.body)).not.toMatch(/ya29\.|refresh/i);
    const test = await request(app).post('/api/calendar/me/test').set(bearer(t1));
    expect(test.body).toMatchObject({
      ok: true,
      message: `Connected to ${T1.email}`,
      timeZone: 'Asia/Kolkata',
    });

    // Malformed, unknown and missing states.
    expect((await request(app).get('/api/calendar/public/google/start?state=short')).status).toBe(422);
    const unknown = await request(app).get(`/api/calendar/public/google/start?state=${'x'.repeat(43)}`);
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('Link not valid');
    expect((await request(app).get('/api/calendar/public/google/callback?code=abc')).status).toBe(400);
    expect(
      (await request(app).get(`/api/calendar/public/google/callback?state=${'y'.repeat(43)}&code=abc`))
        .status,
    ).toBe(400);
    // Logged request URLs never carry the state or the code.
    const logged = redactUrl(back);
    expect(logged).toContain('?state=[redacted]&code=[redacted]&');
    expect(logged).not.toContain(flow.state);
  });

  it('reports declined, partial, expired and failed consents without connecting anything', async () => {
    const declined = await begin(t2, '/api/calendar/me/connect');
    const d = await request(app).get(fake.deny(declined.google)).set('Cookie', declined.cookie);
    expect(d.headers.location).toBe(`${config.publicWebUrl}/appointments/availability?calendar=denied`);

    // The calendar permission was unticked: the grant is handed back to Google.
    const partial = await begin(t2, '/api/calendar/me/connect');
    const p = await request(app)
      .get(fake.consent(partial.google, T2, { scopes: ['openid', 'email'] }))
      .set('Cookie', partial.cookie);
    expect(p.headers.location).toBe(
      `${config.publicWebUrl}/appointments/availability?calendar=missing_scope`,
    );
    expect(fake.revokes).toContain(T2.email);
    expect(fake.refreshTokensOf(T2.email)).toHaveLength(0);

    // From the mobile app (system browser): a static "return to the app" page.
    const native = await begin(t2, '/api/calendar/me/connect', 'native');
    fake.failNext('POST /token', { status: 500, body: { error: 'internal_failure' } });
    const n = await request(app).get(fake.consent(native.google, T2)).set('Cookie', native.cookie);
    expect(n.status).toBe(200);
    expect(n.headers['content-type']).toMatch(/^text\/html/);
    expect(n.headers['content-security-policy']).toBe(PAGE_CSP);
    expect(n.headers['cache-control']).toBe('no-store');
    expect(n.text).toContain('Google Calendar not connected');
    expect(n.text).not.toMatch(/<script/i);

    const noRefresh = await begin(t2, '/api/calendar/me/connect', 'native');
    const r = await request(app)
      .get(fake.consent(noRefresh.google, T2, { noRefresh: true }))
      .set('Cookie', noRefresh.cookie);
    expect(r.text).toContain('Google Calendar not connected');

    const late = await begin(t2, '/api/calendar/me/connect');
    await asApex(() =>
      CalendarOAuthState.update(
        { expiresAt: new Date(Date.now() - 1000) },
        { where: { instituteId: 1, stateHash: sha256(late.state) } },
      ),
    );
    const before = tokenCalls().length;
    const l = await request(app).get(fake.consent(late.google, T2)).set('Cookie', late.cookie);
    expect(l.headers.location).toBe(`${config.publicWebUrl}/appointments/availability?calendar=expired`);
    expect(tokenCalls()).toHaveLength(before);

    expect(await connectionOf(t2Id)).toBeNull();
    expect((await request(app).get('/api/calendar/me').set(bearer(t2))).body.connection).toBeNull();
  });

  // ------------------------------------------------------------ appointment sync

  let meetUrl: string;
  let retriedId: number;

  it("puts approved meetings in the teacher's calendar with a Meet link and keeps them in step", async () => {
    const settings = async () => (await request(app).get('/api/calendar/settings').set(bearer(admin))).body;
    const before = (await settings()).sync;
    const date = daysAhead(20);
    const id = await requestMeeting(t1Id, date);

    const approved = await approve(t1, id, { note: 'See you then' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('confirmed');
    meetUrl = approved.body.meetingUrl;
    expect(meetUrl).toMatch(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    const a = (await appointment(id))!;
    expect(a.calendarProvider).toBe('google');
    const eventId = a.calendarEventId!;
    expect(eventId).toMatch(/^[a-v0-9]{5,1024}$/);

    const create = fake.calls.find((c) => c.method === 'POST' && c.body?.id === eventId)!;
    expect(create.account).toBe(T1.email);
    expect(create.path).toBe('/calendar/v3/calendars/primary/events');
    expect(create.query).toMatchObject({ conferenceDataVersion: '1', sendUpdates: 'all' });
    const ev = fake.event(T1.email, eventId)!;
    expect(ev).toMatchObject({
      status: 'confirmed',
      summary: 'Parent-teacher meeting: Gcal Child',
      description: 'Discuss progress',
      start: { dateTime: at(date, '10:00'), timeZone: tz },
      end: { dateTime: at(date, '10:30'), timeZone: tz },
      hangoutLink: meetUrl,
    });
    expect(ev.attendees.map((x: { email: string }) => x.email).sort()).toEqual(
      [PARENT_EMAIL, T1.email].sort(),
    );

    // Staff see where the event stands; parents do not.
    expect(await syncOf(id)).toMatchObject({ provider: 'google', status: 'synced', error: null });
    const asParent = await request(app).get(`/api/appointments/${id}`).set(bearer(parent));
    expect(asParent.body.calendarSync).toBeNull();
    expect(asParent.body.meetingUrl).toBe(meetUrl);
    const synced = (await settings()).sync;
    expect(synced.synced - before.synced).toBe(1);

    // The teacher moves it: the same event moves and keeps its Meet link.
    const moved = await request(app)
      .post(`/api/appointments/${id}/reschedule`)
      .set(bearer(t1))
      .send({ date: daysAhead(21), startTime: '11:00', reason: 'Clash' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.meetingUrl).toBe(meetUrl);
    const patch = fake.calls.filter((c) => c.method === 'PATCH').at(-1)!;
    expect(patch.path).toBe(`/calendar/v3/calendars/primary/events/${eventId}`);
    expect(Object.keys(patch.body!).sort()).toEqual(['end', 'start']);
    expect(fake.event(T1.email, eventId)!.start.dateTime).toBe(at(daysAhead(21), '11:00'));
    expect(fake.eventsOf(T1.email)).toHaveLength(1);

    // Cancelled: the event is deleted (Google emails the guests) and the link is done with.
    const cancelled = await request(app)
      .post(`/api/appointments/${id}/cancel`)
      .set(bearer(t1))
      .send({ reason: 'Teacher unwell' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.meetingUrl).toBeNull();
    const del = fake.calls.filter((c) => c.method === 'DELETE').at(-1)!;
    expect(del).toMatchObject({
      path: `/calendar/v3/calendars/primary/events/${eventId}`,
      query: { sendUpdates: 'all' },
      account: T1.email,
    });
    expect(fake.event(T1.email, eventId)!.status).toBe('cancelled');
    expect(await linkOf(id)).toMatchObject({ status: 'deleted', eventId: null, generation: 1 });
    expect((await appointment(id))!.calendarEventId).toBeNull();
    expect((await settings()).sync).toEqual(before);
  });

  it('never holds up the meeting when Google fails: the sync retries in the background', async () => {
    const id = await requestMeeting(t1Id, daysAhead(22), '09:00', '09:30');
    fake.failNext('POST /calendar/v3/calendars/primary/events', {
      status: 503,
      body: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } },
    });
    const approved = await approve(t1, id);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('confirmed');
    expect(approved.body.meetingUrl).toBeNull();
    expect(await syncOf(id)).toMatchObject({ status: 'pending', error: expect.any(String) });
    const queued = await Job.findAll({
      where: { name: 'calendar.sync', status: 'pending', id: { [Op.gt]: marks.jobs } },
    });
    expect(queued.some((j) => j.payload.sourceId === id)).toBe(true);

    await runCalendarJobs();
    expect(await syncOf(id)).toMatchObject({ status: 'synced', error: null });
    const a = (await appointment(id))!;
    expect(a.meetingUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    // The retry used the same event id: one event, however many attempts.
    expect(
      fake.eventsOf(T1.email).filter((e) => e.extendedProperties?.private?.erpRef === `appointments:${id}`),
    ).toHaveLength(1);
    retriedId = id;
  });

  it('waits for Google to finish creating the Meet link', async () => {
    const id = await requestMeeting(t1Id, daysAhead(24));
    fake.meetPending = true;
    const approved = await approve(t1, id);
    fake.meetPending = false;
    expect(approved.status).toBe(200);
    expect(approved.body.meetingUrl).toBeNull();
    expect(await syncOf(id)).toMatchObject({ status: 'pending' });

    await runCalendarJobs();
    expect(await syncOf(id)).toMatchObject({ status: 'synced', error: null });
    const a = (await appointment(id))!;
    expect(a.meetingUrl).toBe(fake.event(T1.email, a.calendarEventId!)!.hangoutLink);
    expect(a.meetingUrl).toMatch(/^https:\/\/meet\.google\.com\//);
  });

  it('keeps a meeting link the teacher enters instead of adding Google Meet', async () => {
    const id = await requestMeeting(t1Id, daysAhead(25));
    const bad = await approve(t1, id, { meetingUrl: 'javascript:alert(1)' });
    expect(bad.status).toBe(422);
    const ok = await approve(t1, id, { meetingUrl: 'https://zoom.us/j/123456789' });
    expect(ok.status).toBe(200);
    expect(ok.body.meetingUrl).toBe('https://zoom.us/j/123456789');
    const a = (await appointment(id))!;
    const ev = fake.event(T1.email, a.calendarEventId!)!;
    expect(ev.conferenceData ?? null).toBeNull();
    expect(ev.hangoutLink ?? null).toBeNull();
    expect(ev.description).toBe('Discuss progress\n\nMeeting link: https://zoom.us/j/123456789');
    expect((await appointment(id))!.meetingUrl).toBe('https://zoom.us/j/123456789');
  });

  // ------------------------------------------------------------ organiser calendar

  let organiserId: number;
  let t2MeetingId: number;

  it("falls back to the institute's organiser calendar for teachers without their own", async () => {
    t2MeetingId = await requestMeeting(t2Id, daysAhead(26));
    const approved = await approve(t2, t2MeetingId);
    expect(approved.status).toBe(200);
    expect(await syncOf(t2MeetingId)).toMatchObject({
      status: 'failed',
      error: 'No Google Calendar is connected',
    });

    const flow = await begin(admin, '/api/calendar/organiser/connect', 'native');
    expect(new URL(flow.google).searchParams.has('login_hint')).toBe(false);
    const done = await request(app).get(fake.consent(flow.google, OFFICE)).set('Cookie', flow.cookie);
    expect(done.status).toBe(200);
    expect(done.text).toContain('Google Calendar connected');
    expect(done.text).toContain('return to the app');
    expect(done.headers['content-security-policy']).toBe(PAGE_CSP);
    const organiser = (await connectionOf(null))!;
    expect(organiser).toMatchObject({
      accountEmail: OFFICE.email,
      status: 'active',
      ownerKey: expect.any(String),
    });
    organiserId = organiser.id;

    // Connecting queues the meetings that were waiting for a calendar.
    await runCalendarJobs();
    expect(await syncOf(t2MeetingId)).toMatchObject({ status: 'synced', error: null });
    const a = (await appointment(t2MeetingId))!;
    const ev = fake.event(OFFICE.email, a.calendarEventId!)!;
    expect(ev.attendees.map((x: { email: string }) => x.email).sort()).toEqual(
      [PARENT_EMAIL, T2.email].sort(),
    );
    expect(a.meetingUrl).toBe(ev.hangoutLink);
    // Teacher One's meetings stay in Teacher One's calendar.
    expect(
      fake
        .eventsOf(OFFICE.email)
        .some((e) => e.extendedProperties?.private?.erpRef === `appointments:${retriedId}`),
    ).toBe(false);

    expect((await request(app).get('/api/calendar/me').set(bearer(t2))).body).toMatchObject({
      connection: null,
      organiserConnected: true,
    });
    const settings = (await request(app).get('/api/calendar/settings').set(bearer(admin))).body;
    expect(settings.organiser).toMatchObject({ id: organiserId, accountEmail: OFFICE.email, userId: null });
    expect(settings.teachers.map((c: { userId: number }) => c.userId)).toContain(t1Id);
  });

  // ------------------------------------------------------------ revoked access

  it('flags a revoked grant for reconnecting without blocking meetings, and catches up afterwards', async () => {
    fake.revokeAccount(T1.email);
    const moved = await request(app)
      .post(`/api/appointments/${retriedId}/reschedule`)
      .set(bearer(t1))
      .send({ date: daysAhead(23), startTime: '09:00' });
    expect(moved.status).toBe(200);
    expect(await syncOf(retriedId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining(RECONNECT),
    });
    expect((await connectionOf(t1Id))!).toMatchObject({
      status: 'needs_reconnect',
      lastError: expect.any(String),
    });

    // New meetings wait for the teacher's calendar rather than silently using the organiser's.
    const id = await requestMeeting(t1Id, daysAhead(27));
    expect((await approve(t1, id)).status).toBe(200);
    expect(await syncOf(id)).toMatchObject({ status: 'failed', error: RECONNECT });
    expect(
      fake.eventsOf(OFFICE.email).some((e) => e.extendedProperties?.private?.erpRef === `appointments:${id}`),
    ).toBe(false);

    const test = await request(app).post('/api/calendar/me/test').set(bearer(t1));
    expect(test.body.ok).toBe(false);
    expect(test.body.message).toMatch(/revoked or has expired\. Reconnect/);
    expect((await request(app).get('/api/calendar/me').set(bearer(t1))).body.connection.status).toBe(
      'needs_reconnect',
    );
    expect(
      (await request(app).get('/api/admin/calendar').set(bearer(superAdmin))).body.connections.needsReconnect,
    ).toBeGreaterThanOrEqual(1);

    // Reconnecting (Google pre-selects the same account) resumes both.
    const flow = await begin(t1, '/api/calendar/me/connect');
    expect(new URL(flow.google).searchParams.get('login_hint')).toBe(T1.email);
    const before = (await connectionOf(t1Id))!.id;
    const done = await request(app).get(fake.consent(flow.google, T1)).set('Cookie', flow.cookie);
    expect(done.headers.location).toBe(`${config.publicWebUrl}/appointments/availability?calendar=connected`);
    expect((await connectionOf(t1Id))!).toMatchObject({ id: before, status: 'active', lastError: null });

    await runCalendarJobs();
    expect(await syncOf(retriedId)).toMatchObject({ status: 'synced', error: null });
    expect(await syncOf(id)).toMatchObject({ status: 'synced', error: null });
    const moved1 = (await appointment(retriedId))!;
    expect(fake.event(T1.email, moved1.calendarEventId!)!.start.dateTime).toBe(at(daysAhead(23), '09:00'));
    expect(fake.event(T1.email, (await appointment(id))!.calendarEventId!)).toBeDefined();
  });

  // ------------------------------------------------------------ isolation & disconnect

  it('keeps calendar connections inside their institute', async () => {
    const conn = (await connectionOf(t1Id))!;
    const other = (await request(app).get('/api/calendar/settings').set(bearer(zenith))).body;
    expect(other.organiser).toBeNull();
    expect(other.teachers.some((c: { id: number }) => c.id === conn.id || c.id === organiserId)).toBe(false);
    expect(
      (await request(app).post(`/api/calendar/connections/${conn.id}/test`).set(bearer(zenith))).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/calendar/connections/${conn.id}`).set(bearer(zenith))).status,
    ).toBe(404);
    expect((await request(app).get('/api/calendar/settings').set(bearer(t1))).status).toBe(403);
    expect((await connectionOf(t1Id))!.status).toBe('active');
  });

  it('disconnects: revokes the grant unless another connection shares the Google account', async () => {
    // Teacher Two connects the office account the organiser calendar also uses.
    const flow = await begin(t2, '/api/calendar/me/connect');
    const done = await request(app).get(fake.consent(flow.google, OFFICE)).set('Cookie', flow.cookie);
    expect(done.headers.location).toBe(`${config.publicWebUrl}/appointments/availability?calendar=connected`);
    await runCalendarJobs();
    // Same Google account: the existing event stays where it is.
    expect(await syncOf(t2MeetingId)).toMatchObject({ status: 'synced' });
    expect(fake.eventsOf(OFFICE.email).filter((e) => e.status === 'confirmed').length).toBeGreaterThanOrEqual(
      1,
    );

    const revokes = fake.revokes.length;
    expect((await request(app).delete('/api/calendar/me').set(bearer(t2))).status).toBe(204);
    expect(fake.revokes).toHaveLength(revokes);
    expect(
      (await request(app).post(`/api/calendar/connections/${organiserId}/test`).set(bearer(admin))).body,
    ).toMatchObject({ ok: true, message: `Connected to ${OFFICE.email}` });

    // An admin disconnects Teacher One: the grant is revoked, the events stay in Google.
    const conn = (await connectionOf(t1Id))!;
    expect(
      (await request(app).delete(`/api/calendar/connections/${conn.id}`).set(bearer(admin))).status,
    ).toBe(204);
    expect(fake.revokes.slice(revokes)).toEqual([T1.email]);
    expect(fake.refreshTokensOf(T1.email)).toHaveLength(0);
    expect(fake.eventsOf(T1.email).filter((e) => e.status === 'confirmed').length).toBeGreaterThanOrEqual(1);
    expect(
      (await request(app).delete(`/api/calendar/connections/${conn.id}`).set(bearer(admin))).status,
    ).toBe(404);
    expect((await request(app).delete('/api/calendar/me').set(bearer(t1))).status).toBe(404);
    expect((await request(app).get('/api/calendar/me').set(bearer(t1))).body.connection).toBeNull();
  });

  it('limits how many connection links a user can have open', async () => {
    for (let i = 0; i < 10; i++)
      expect((await request(app).post('/api/calendar/me/connect').set(bearer(t2)).send({})).status).toBe(200);
    const blocked = await request(app).post('/api/calendar/me/connect').set(bearer(t2)).send({});
    expect(blocked.status).toBe(429);
  });
});
