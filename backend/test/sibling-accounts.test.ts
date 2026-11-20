import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/infrastructure/config';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import { Device, clearSignInLock } from '../src/modules/authentication/api';
import { OtpChallenge } from '../src/modules/authentication/models';
import { FeeAccount, FeeCourseEnrolment, FeeEntitlement } from '../src/modules/fees/models';
import { notify } from '../src/modules/notifications/api';
import { backfillStudentAccounts } from '../src/modules/students/account-backfill';
import { User } from '../src/modules/users/user.model';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { runWithContext } from '../src/shared/context';
import { type TestDevice, getApp, lastOtpFor, newDevice, purgeRows } from './helpers';
import {
  type Tenant,
  createInstitute,
  createSuperAdmin,
  ok,
  purgeInstitutes,
  query,
} from './security/harness';

/**
 * Students who share a mobile (siblings on a parent's number) each have an account of their own: "Who's
 * signing in?" once the number's OTP is verified, batch enrolment on admission, and the backfill for
 * students admitted before (docs/security.md, CONTRIBUTING.md). Mobiles 9590….
 */
const PREFIX = '9590';
const RUN = String(crypto.randomInt(1000)).padStart(3, '0');
let n = 0;
const mobile = () => `${PREFIX}${RUN}${String(n++).padStart(3, '0')}`;
const PASSWORD = 'Sibling@12345';
const WRONG = 'Not-the-password-1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const masked = (m: string) => `${'•'.repeat(m.length - 4)}${m.slice(-4)}`;

let tenant: Tenant;
let branchId: number;
let c1: number, c2: number, c3: number;
let b1: number, b2: number, b3: number;

beforeAll(async () => {
  const superAdmin = await createSuperAdmin(mobile());
  const tag = crypto.randomBytes(3).toString('hex');
  tenant = await createInstitute(superAdmin, {
    slug: `sib${tag}`,
    name: `Siblings ${tag}`,
    adminMobile: mobile(),
    label: 'admin',
  });
  branchId = tenant.mainBranchId;
  const admin = tenant.admin;
  await ok(admin, 'PUT', '/api/attendance/settings', { mode: 'daily' });
  const session = await ok(admin, 'POST', '/api/academics/sessions', {
    name: `Siblings ${tag}`,
    startDate: '2020-04-01',
    endDate: '2040-03-31',
  });
  const code = (name: string) => `SIB-${name}-${tag.toUpperCase()}`;
  const course = async (name: string): Promise<number> =>
    (
      await ok(admin, 'POST', '/api/academics/courses', {
        name: `Course ${name}`,
        code: code(name),
        branchIds: [branchId],
      })
    ).id;
  const batch = async (courseId: number, name: string, capacity: number): Promise<number> =>
    (
      await ok(admin, 'POST', '/api/academics/batches', {
        branchId,
        courseId,
        academicSessionId: session.id,
        name: `Batch ${name}`,
        code: code(name),
        capacity,
        startDate: '2020-04-01',
        status: 'active',
      })
    ).id;
  c1 = await course('C1');
  c2 = await course('C2');
  c3 = await course('C3');
  b1 = await batch(c1, 'B1', 10);
  b2 = await batch(c2, 'B2', 1);
  b3 = await batch(c3, 'B3', 10);
}, 120_000);

afterAll(async () => {
  const users = await query<{ id: number }>(
    'SELECT id FROM users WHERE mobile LIKE ? OR shared_mobile LIKE ?',
    [`${PREFIX}%`, `${PREFIX}%`],
  );
  if (users.length) {
    const userIds = users.map((u) => u.id);
    const devices = await Device.findAll({ where: { userId: userIds }, attributes: ['id'] });
    // Sign-in, lock and device events are platform-wide (no institute), so purgeInstitutes leaves them.
    await AuditEvent.destroy({
      where: { instituteId: null, entityType: 'user', entityId: userIds.map(String) },
    });
    if (devices.length)
      await AuditEvent.destroy({
        where: { instituteId: null, entityType: 'device', entityId: devices.map((d) => String(d.id)) },
      });
  }
  await purgeInstitutes([tenant?.id], PREFIX);
  await getSequelize().query('DELETE FROM otp_challenges WHERE mobile LIKE ?', {
    replacements: [`${PREFIX}%`],
  });
}, 120_000);

interface Admitted {
  id: number;
  userId: number;
}

/** Adds a student on `m` as the institute admin (a sibling's duplicate warning accepted). */
const addStudent = (name: string, m: string, extra: object = {}): Promise<Admitted> =>
  ok(tenant.admin, 'POST', '/api/students', { name, mobile: m, branchId, allowDuplicate: true, ...extra });

/** Applies on `m` for a course and batch, and admits the applicant to the batch. */
async function admit(name: string, m: string, courseId: number, batchId: number) {
  const application = await ok(tenant.admin, 'POST', '/api/admissions/applications', {
    name,
    mobile: m,
    branchId,
    courseId,
    batchId,
  });
  return ok(tenant.admin, 'POST', `/api/admissions/applications/${application.id}/admit`, {
    batchId,
    allowDuplicate: true,
  });
}

const post = async (url: string, body: object) =>
  request(await getApp())
    .post(url)
    .send(body);
const outcome = (res: request.Response) => `${res.status} ${res.body.error?.code ?? res.body.status}`;
const count = async (sql: string, replacements: unknown[]) =>
  Number((await query<{ n: number }>(sql, replacements))[0].n);

async function requestOtp(m: string, device: TestDevice) {
  const res = await post('/api/auth/otp/request', { mobile: m, device });
  expect(res.status).toBe(200);
  return res.body;
}

/** Requests a sign-in code for `m` on `device` and enters it. */
async function verifyCode(m: string, device: TestDevice) {
  const { challengeId } = await requestOtp(m, device);
  return post('/api/auth/otp/verify', { challengeId, code: lastOtpFor(m), device });
}

const choose = (selectionToken: string, userId: number, device: TestDevice) =>
  post('/api/auth/select-profile', { selectionToken, userId, device });

/** Signs in as `userId` through the "Who's signing in?" step of `m`. */
async function signInAs(m: string, userId: number, device: TestDevice = newDevice()) {
  const verified = await verifyCode(m, device);
  expect(outcome(verified)).toBe('200 choose_profile');
  const res = await choose(verified.body.selectionToken, userId, device);
  expect(outcome(res)).toBe('200 authenticated');
  return res.body as { accessToken: string; refreshToken: string };
}

const me = async (token: string) => (await ok(token, 'GET', '/api/auth/me')).user;

describe("Who's signing in?", () => {
  const shared = mobile();
  const single = mobile();
  const unknown = mobile();
  let owner: Admitted;
  let sibling: Admitted;
  let only: Admitted;

  beforeAll(async () => {
    owner = await addStudent('Owner One', shared);
    sibling = await addStudent('Sibling One', shared);
    only = await addStudent('Only Child', single);
  }, 60_000);

  it('gives a sibling an account of their own that shares the mobile', async () => {
    expect(sibling.userId).toEqual(expect.any(Number));
    expect(
      await query('SELECT id, mobile, shared_mobile FROM users WHERE id IN (?) ORDER BY id', [
        [owner.userId, sibling.userId],
      ]),
    ).toEqual([
      { id: owner.userId, mobile: shared, shared_mobile: null },
      { id: sibling.userId, mobile: null, shared_mobile: shared },
    ]);
  });

  it('answers a code request alike whether the number has several accounts, one or none', async () => {
    const numbers = [shared, single, unknown];
    const answers: { challengeId: string }[] = [];
    for (const m of numbers) answers.push(await requestOtp(m, newDevice()));
    answers.forEach((body, i) => {
      expect(Object.keys(body).sort()).toEqual(['challengeId', 'maskedMobile', 'reason', 'status']);
      expect(body).toMatchObject({
        status: 'otp_required',
        reason: 'otp_login',
        maskedMobile: masked(numbers[i]),
      });
      expect(body.challengeId).toMatch(UUID);
    });
    // One code to the shared number (not one per account), none to an unknown one.
    const codes = (m: string) => consoleOutbox.filter((x) => x.to === m && x.data?.otp).length;
    expect(numbers.map(codes)).toEqual([1, 1, 0]);
    const rows = await query<{ id: string; user_id: number | null }>(
      'SELECT id, user_id FROM otp_challenges WHERE mobile IN (?) ORDER BY mobile',
      [numbers],
    );
    expect(rows).toEqual([
      { id: answers[0].challengeId, user_id: owner.userId },
      { id: answers[1].challengeId, user_id: only.userId },
    ]);

    // A wrong code fails the same way for each; the right one signs a single account straight in.
    const wrong = (code: string) => code.replace(/\d$/, (d) => String((Number(d) + 1) % 10));
    const verify = (i: number, code: string) =>
      post('/api/auth/otp/verify', { challengeId: answers[i].challengeId, code, device: newDevice() });
    expect(
      [
        await verify(0, wrong(lastOtpFor(shared))),
        await verify(1, wrong(lastOtpFor(single))),
        await verify(2, wrong(lastOtpFor(shared))),
      ].map(outcome),
    ).toEqual(Array(3).fill('401 OTP_INVALID'));
  });

  it('signs a number with one account straight in', async () => {
    const device = newDevice();
    const res = await verifyCode(single, device);
    expect(outcome(res)).toBe('200 authenticated');
    expect(await me(res.body.accessToken)).toMatchObject({
      id: only.userId,
      sharesMobile: false,
      profileCount: 1,
    });
  });

  it("offers the number's accounts once the code is verified and signs in as the one chosen", async () => {
    const device = newDevice();
    const verified = await verifyCode(shared, device);
    expect(verified.status).toBe(200);
    expect(verified.body).not.toHaveProperty('accessToken');
    expect(verified.body).toMatchObject({ status: 'choose_profile', expiresIn: config.OTP_TTL_SECONDS });
    const membership = expect.objectContaining({ id: tenant.id, roles: ['student'] });
    expect(verified.body.profiles).toEqual([
      { id: owner.userId, name: 'Owner One', memberships: [membership] },
      { id: sibling.userId, name: 'Sibling One', memberships: [membership] },
    ]);

    const chosen = await choose(verified.body.selectionToken, sibling.userId, device);
    expect(outcome(chosen)).toBe('200 authenticated');
    expect(await me(chosen.body.accessToken)).toMatchObject({
      id: sibling.userId,
      mobile: shared,
      sharesMobile: true,
      profileCount: 2,
    });
    const login = await AuditEvent.findOne({
      where: { action: 'auth.login', entityType: 'user', entityId: String(sibling.userId) },
      order: [['id', 'DESC']],
    });
    expect(login?.metadata).toEqual({ method: 'otp', purpose: 'login', profileChosen: true });

    // The selection works once.
    expect(outcome(await choose(verified.body.selectionToken, owner.userId, device))).toBe(
      '401 PROFILE_SELECTION_INVALID',
    );
  }, 60_000);

  it('refuses a forged selection, another account or another device, and keeps the selection usable', async () => {
    const device = newDevice();
    const { body } = await verifyCode(shared, device);
    const [challengeId] = body.selectionToken.split('.');
    const fake = 'x'.repeat(43);
    const refused = [
      await choose(`${crypto.randomUUID()}.${fake}`, sibling.userId, device),
      await choose(`${challengeId}.${fake}`, sibling.userId, device),
      await choose(body.selectionToken, only.userId, device),
      await choose(body.selectionToken, tenant.admin.userId, device),
      await choose(body.selectionToken, sibling.userId, newDevice()),
    ];
    expect(refused.map(outcome)).toEqual(Array(5).fill('401 PROFILE_SELECTION_INVALID'));

    const res = await choose(body.selectionToken, owner.userId, device);
    expect(outcome(res)).toBe('200 authenticated');
    expect(await me(res.body.accessToken)).toMatchObject({
      id: owner.userId,
      mobile: shared,
      sharesMobile: false,
      profileCount: 2,
    });
  }, 60_000);

  it('refuses an expired selection', async () => {
    const device = newDevice();
    const { body } = await verifyCode(shared, device);
    await OtpChallenge.update(
      { selectionExpiresAt: new Date(Date.now() - 1000) },
      { where: { id: body.selectionToken.split('.')[0] } },
    );
    expect(outcome(await choose(body.selectionToken, sibling.userId, device))).toBe(
      '401 PROFILE_SELECTION_INVALID',
    );
  });
});

describe('the chosen account keeps its own sign-in policy', () => {
  const shared = mobile();
  const email = `sibling-two-${RUN}@example.com`;
  let owner: Admitted;
  let sibling: Admitted;

  beforeAll(async () => {
    owner = await addStudent('Owner Two', shared);
    sibling = await addStudent('Sibling Two', shared, { email, password: PASSWORD });
  }, 60_000);

  it("applies the chosen account's device limit, leaving the number's other accounts open", async () => {
    const devices = await Promise.all(
      Array.from({ length: config.MAX_ACTIVE_DEVICES }, () =>
        Device.create({
          userId: sibling.userId,
          deviceUid: newDevice().uid,
          name: null,
          platform: 'web',
          lastSeenAt: new Date(),
          lastIp: null,
          revokedAt: null,
          revokedBy: null,
        }),
      ),
    );
    try {
      const device = newDevice();
      const { body } = await verifyCode(shared, device);
      expect((await choose(body.selectionToken, sibling.userId, device)).body).toEqual({
        status: 'device_limit_reached',
        maxDevices: config.MAX_ACTIVE_DEVICES,
      });
      expect(outcome(await choose(body.selectionToken, owner.userId, device))).toBe('200 authenticated');
    } finally {
      await Promise.all(devices.map((d) => d.destroy()));
    }
  }, 60_000);

  it('keeps a locked account locked through the number', async () => {
    const outcomes = [];
    for (let i = 0; i < 5; i++)
      outcomes.push(
        outcome(await post('/api/auth/login', { identifier: email, password: WRONG, device: newDevice() })),
      );
    const INVALID = '401 INVALID_CREDENTIALS';
    expect(outcomes).toEqual([INVALID, INVALID, INVALID, INVALID, '429 ACCOUNT_LOCKED']);
    try {
      const device = newDevice();
      const { body } = await verifyCode(shared, device);
      expect(outcome(await choose(body.selectionToken, sibling.userId, device))).toBe('429 ACCOUNT_LOCKED');
      expect(outcome(await choose(body.selectionToken, owner.userId, device))).toBe('200 authenticated');
    } finally {
      await clearSignInLock(sibling.userId);
    }
  }, 60_000);

  it("keeps the account's lock when the code was checked under another of the number's accounts", async () => {
    // Nobody owns the number any more, and its first account belongs nowhere (hidden from the chooser):
    // the code is checked under that account, and the one account offered signs in straight away.
    const number = mobile();
    const email4 = `sibling-four-${RUN}@example.com`;
    const owner4 = await addStudent('Owner Four', number);
    const orphan = await User.create({
      name: 'Orphan Four',
      mobile: null,
      sharedMobile: number,
      email: null,
      passwordHash: null,
      lastLoginAt: null,
    });
    const only = await addStudent('Sibling Four', number, { email: email4, password: PASSWORD });
    await User.update({ mobile: mobile() }, { where: { id: owner4.userId } });
    expect(only.userId).toBeGreaterThan(orphan.id);

    for (let i = 0; i < 5; i++)
      await post('/api/auth/login', { identifier: email4, password: WRONG, device: newDevice() });
    try {
      const device = newDevice();
      const { challengeId } = await requestOtp(number, device);
      expect((await OtpChallenge.findByPk(challengeId))?.userId).toBe(orphan.id);
      const res = await post('/api/auth/otp/verify', { challengeId, code: lastOtpFor(number), device });
      expect(outcome(res)).toBe('429 ACCOUNT_LOCKED');
    } finally {
      await clearSignInLock(only.userId);
    }
    const res = await verifyCode(number, newDevice());
    expect(outcome(res)).toBe('200 authenticated');
    expect((await me(res.body.accessToken)).id).toBe(only.userId);
  }, 60_000);
});

describe('password sign-in and devices on a shared mobile', () => {
  const shared = mobile();
  const email = `sibling-three-${RUN}@example.com`;
  const SIBLING_PASSWORD = 'Sibling@67890';
  let owner: Admitted;
  let sibling: Admitted;

  beforeAll(async () => {
    owner = await addStudent('Owner Three', shared, { password: PASSWORD });
    sibling = await addStudent('Sibling Three', shared, { email, password: SIBLING_PASSWORD });
  }, 60_000);

  it('signs the mobile in as its owner and a sibling in by email, each with their own device row', async () => {
    const phone = newDevice();
    const login = (identifier: string, password: string, device: TestDevice) =>
      post('/api/auth/login', { identifier, password, device });

    const ownerLogin = await login(shared, PASSWORD, phone);
    expect(outcome(ownerLogin)).toBe('200 authenticated');
    expect((await me(ownerLogin.body.accessToken)).id).toBe(owner.userId);
    // The mobile names the account that owns it: a sibling's password doesn't open it.
    expect(outcome(await login(shared, SIBLING_PASSWORD, newDevice()))).toBe('401 INVALID_CREDENTIALS');

    expect(outcome(await login(email, SIBLING_PASSWORD, newDevice()))).toBe('200 authenticated');
    // A new device for the sibling: the code goes to the mobile they share.
    const challenged = await login(email, SIBLING_PASSWORD, phone);
    expect(challenged.body).toMatchObject({
      status: 'otp_required',
      reason: 'new_device',
      maskedMobile: masked(shared),
    });
    const verified = await post('/api/auth/otp/verify', {
      challengeId: challenged.body.challengeId,
      code: lastOtpFor(shared),
      device: phone,
    });
    expect(outcome(verified)).toBe('200 authenticated');
    expect((await me(verified.body.accessToken)).id).toBe(sibling.userId);
    expect(
      (
        await query<{ user_id: number }>(
          'SELECT user_id FROM devices WHERE device_uid = ? ORDER BY user_id',
          [phone.uid],
        )
      ).map((d) => d.user_id),
    ).toEqual([owner.userId, sibling.userId]);

    // Choosing the sibling again on the same phone reuses their device row.
    const chosen = await signInAs(shared, sibling.userId, phone);
    expect(
      await count("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND status = 'active'", [
        sibling.userId,
      ]),
    ).toBe(2);

    // Signing one account out of the phone leaves the other signed in.
    expect((await post('/api/auth/logout', { refreshToken: ownerLogin.body.refreshToken })).status).toBe(204);
    expect(outcome(await post('/api/auth/refresh', { refreshToken: ownerLogin.body.refreshToken }))).toBe(
      '401 INVALID_REFRESH_TOKEN',
    );
    expect((await post('/api/auth/refresh', { refreshToken: chosen.refreshToken })).status).toBe(200);
  }, 60_000);
});

describe('a sibling admitted on a shared mobile', () => {
  const shared = mobile();
  let owner: Admitted;
  let sibling: Admitted;
  let year: number;

  beforeAll(async () => {
    owner = await addStudent('Owner Four', shared);
  }, 60_000);

  it('is enrolled in the batch on admission and appears in its attendance', async () => {
    const admitted = await admit('Sibling Four', shared, c1, b1);
    expect(admitted.batchEnrolment).toBe('enrolled');
    sibling = { id: admitted.student.id, userId: admitted.student.userId };
    expect(sibling.userId).toEqual(expect.any(Number));
    expect(sibling.userId).not.toBe(owner.userId);
    expect(await query('SELECT mobile, shared_mobile FROM users WHERE id = ?', [sibling.userId])).toEqual([
      { mobile: null, shared_mobile: shared },
    ]);
    expect(
      await count('SELECT COUNT(*) AS n FROM batch_students WHERE batch_id = ? AND student_user_id = ?', [
        b1,
        sibling.userId,
      ]),
    ).toBe(1);

    const { session, roster } = await ok(tenant.admin, 'POST', '/api/attendance/sessions', { batchId: b1 });
    expect(roster.map((r: { studentUserId: number }) => r.studentUserId)).toContain(sibling.userId);
    await ok(tenant.admin, 'PUT', `/api/attendance/sessions/${session.id}/records`, {
      records: [{ studentUserId: sibling.userId, status: 'present' }],
    });
    year = Number(String(session.date).slice(0, 4));
  }, 60_000);

  it('signs in as themselves and sees their attendance', async () => {
    const { accessToken } = await signInAs(shared, sibling.userId);
    expect(await me(accessToken)).toMatchObject({ id: sibling.userId, mobile: shared, sharesMobile: true });
    expect(await ok(accessToken, 'GET', `/api/attendance/me/summary?year=${year}`)).toMatchObject({
      studentUserId: sibling.userId,
      overall: { percentage: 100 },
    });
    await ok(accessToken, 'GET', '/api/student-portal/me');
  }, 60_000);

  it("stays in the parent's portal, the parent being the account that owns the mobile", async () => {
    const link = await ok(tenant.admin, 'POST', `/api/students/${sibling.id}/guardians`, {
      name: 'Parent Four',
      mobile: shared,
      relation: 'father',
    });
    // The first child's account also carries the parent role (kept as before).
    expect(link.userId).toBe(owner.userId);

    const device = newDevice();
    const verified = await verifyCode(shared, device);
    const profile = verified.body.profiles.find((p: { id: number }) => p.id === owner.userId);
    expect([...profile.memberships[0].roles].sort()).toEqual(['parent', 'student']);
    const chosen = await choose(verified.body.selectionToken, owner.userId, device);
    expect(outcome(chosen)).toBe('200 authenticated');
    const token = chosen.body.accessToken;
    expect(await ok(token, 'GET', '/api/guardian-portal/children')).toEqual(
      expect.arrayContaining([expect.objectContaining({ studentId: sibling.id })]),
    );
    expect(await ok(token, 'GET', '/api/parent-portal/children')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ studentId: sibling.id, studentUserId: sibling.userId }),
      ]),
    );
    expect(await ok(token, 'GET', '/api/attendance/me/children')).toEqual(
      expect.arrayContaining([expect.objectContaining({ studentUserId: sibling.userId })]),
    );
    expect(
      await ok(token, 'GET', `/api/attendance/me/children/${sibling.userId}/summary?year=${year}`),
    ).toMatchObject({ overall: { percentage: 100 } });
  }, 60_000);

  it('is found by the shared mobile and messaged on it', async () => {
    const { items } = await ok(tenant.admin, 'GET', `/api/users?search=${shared}`);
    const found = items.filter((u: { id: number }) => u.id === owner.userId || u.id === sibling.userId);
    expect(found.map((u: { id: number; mobile: string }) => ({ id: u.id, mobile: u.mobile }))).toEqual(
      expect.arrayContaining([
        { id: owner.userId, mobile: shared },
        { id: sibling.userId, mobile: shared },
      ]),
    );
    expect(found).toHaveLength(2);

    const receiptNo = `R-${RUN}-SIB`;
    await runWithContext({ system: true, instituteId: tenant.id, allowedBranchIds: null }, () =>
      notify({
        event: 'fees.receipt',
        recipients: [{ userIds: [sibling.userId], type: 'student' }],
        channels: ['sms'],
        data: { amount: 1500, student: { name: 'Sibling Four' }, receiptNo, paidOn: '2026-01-01' },
      }),
    );
    await processDueJobs();
    expect(consoleOutbox.filter((x) => x.body.includes(receiptNo)).map((x) => [x.channel, x.to])).toEqual([
      ['sms', shared],
    ]);
  }, 60_000);
});

describe('students:backfill-accounts', () => {
  const shared = mobile();
  let legacy: Admitted[];
  let feeAccountId: number;

  /** Legacy Two's batch filled up after their admission. */
  const fullBatch = () => ({
    instituteId: tenant.id,
    studentId: legacy[1].id,
    admissionNumber: expect.any(String),
    student: 'Legacy Two',
    item: `batch "Batch B2" (#${b2})`,
    reason: 'not enrolled: The batch is full',
  });
  const counts = (values: Partial<Record<string, number>> = {}) => ({
    instituteId: tenant.id,
    accountsOwningMobile: 0,
    accountsSharingMobile: 0,
    accountsLinked: 0,
    enrolledInBatch: 0,
    alreadyInBatch: 0,
    coursePurchases: 0,
    ...values,
  });

  beforeAll(async () => {
    await addStudent('Owner Five', shared);
    const admitted = [await admit('Legacy One', shared, c3, b3), await admit('Legacy Two', shared, c2, b2)];
    legacy = [
      ...admitted.map((a) => ({ id: a.student.id, userId: a.student.userId })),
      await addStudent('Legacy Three', shared),
    ];
    const seatHolder = await addStudent('Seat Holder', mobile());

    // As students admitted on a sibling's mobile used to be: no login, so no batch, and a course purchase
    // waiting for one.
    await purgeRows(
      'users',
      legacy.map((s) => s.userId),
    );
    await getSequelize().query(
      `UPDATE student_history SET details = JSON_SET(details, '$.batchEnrolment', 'no_login')
       WHERE institute_id = ? AND student_id IN (?) AND event_type = 'admitted_for_course'`,
      { replacements: [tenant.id, [legacy[0].id, legacy[1].id]] },
    );
    await ok(tenant.admin, 'POST', `/api/academics/batches/${b2}/students`, {
      studentUserIds: [seatHolder.userId],
    });
    await runWithContext({ system: true, instituteId: tenant.id, allowedBranchIds: null }, async () => {
      const student = { instituteId: tenant.id, studentId: legacy[2].id, studentUserId: null, courseId: c3 };
      const account = await FeeAccount.create({
        ...student,
        branchId,
        structureId: null,
        batchId: b3,
        subjectId: null,
        academicSessionId: null,
        title: 'Course C3',
        sourceRef: `purchase:sibling-${RUN}`,
      });
      feeAccountId = account.id;
      await FeeEntitlement.create({
        ...student,
        subjectId: null,
        accountId: account.id,
        grantedAt: new Date(),
        revokedAt: null,
      });
      await FeeCourseEnrolment.create({
        ...student,
        branchId,
        accountId: account.id,
        requestedBatchId: b3,
        batchId: null,
        applicationId: null,
        status: 'awaiting_batch',
        reason: 'no_login',
        enrolledAt: null,
        revokedAt: null,
      });
    });
  }, 120_000);

  it('reports what it would do in a dry run and changes nothing', async () => {
    expect(await backfillStudentAccounts({ dryRun: true, instituteIds: [tenant.id] })).toEqual({
      dryRun: true,
      institutes: [counts({ accountsSharingMobile: 3, enrolledInBatch: 1, coursePurchases: 1 })],
      copies: { fee_accounts: 1, fee_entitlements: 1, fee_course_enrolments: 1, appointments: 0 },
      problems: [fullBatch()],
    });
    expect(
      await count('SELECT COUNT(*) AS n FROM students WHERE institute_id = ? AND user_id IS NULL', [
        tenant.id,
      ]),
    ).toBe(3);
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE shared_mobile = ?', [shared])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM batch_students WHERE batch_id = ?', [b3])).toBe(0);
    expect(
      await query('SELECT status FROM fee_course_enrolments WHERE account_id = ?', [feeAccountId]),
    ).toEqual([{ status: 'awaiting_batch' }]);
  }, 60_000);

  it('gives each student an account on the shared mobile, enrols them and retries their purchase', async () => {
    expect(await backfillStudentAccounts({ instituteIds: [tenant.id] })).toEqual({
      dryRun: false,
      institutes: [counts({ accountsSharingMobile: 3, enrolledInBatch: 1, coursePurchases: 1 })],
      // Retrying the purchase already filled in its enrolment row.
      copies: { fee_accounts: 1, fee_entitlements: 1, fee_course_enrolments: 0, appointments: 0 },
      problems: [fullBatch()],
    });
    const accounts = await query<{
      id: number;
      user_id: number;
      mobile: string | null;
      shared_mobile: string;
    }>(
      `SELECT s.id, s.user_id, u.mobile, u.shared_mobile FROM students s JOIN users u ON u.id = s.user_id
       WHERE s.id IN (?) ORDER BY s.id`,
      [legacy.map((s) => s.id)],
    );
    expect(accounts.map(({ mobile, shared_mobile }) => ({ mobile, shared_mobile }))).toEqual(
      Array(3).fill({ mobile: null, shared_mobile: shared }),
    );
    expect(new Set(accounts.map((a) => a.user_id)).size).toBe(3);
    const [one, , three] = accounts.map((a) => a.user_id);
    expect(
      (
        await query<{ student_user_id: number }>(
          'SELECT student_user_id FROM batch_students WHERE batch_id = ? ORDER BY student_user_id',
          [b3],
        )
      ).map((r) => r.student_user_id),
    ).toEqual([one, three]);
    expect(
      await query(
        `SELECT a.student_user_id AS account, e.student_user_id AS entitlement, c.student_user_id AS enrolment,
                c.status, c.batch_id
           FROM fee_accounts a JOIN fee_entitlements e ON e.account_id = a.id
           JOIN fee_course_enrolments c ON c.account_id = a.id WHERE a.id = ?`,
        [feeAccountId],
      ),
    ).toEqual([{ account: three, entitlement: three, enrolment: three, status: 'enrolled', batch_id: b3 }]);
  }, 60_000);

  it('only reports what is still unresolved when run again', async () => {
    expect(await backfillStudentAccounts({ instituteIds: [tenant.id] })).toEqual({
      dryRun: false,
      institutes: [counts({ alreadyInBatch: 1 })],
      copies: { fee_accounts: 0, fee_entitlements: 0, fee_course_enrolments: 0, appointments: 0 },
      problems: [fullBatch()],
    });
  }, 60_000);
});
