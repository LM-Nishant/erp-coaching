import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/infrastructure/config';
import { getMessagingProvider, setMessagingProvider } from '../src/infrastructure/messaging';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import { hashPassword, verifyPassword } from '../src/infrastructure/password';
import { confirmAccountPassword, signInLocks } from '../src/modules/authentication/api';
import { User } from '../src/modules/users/user.model';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { type TestDevice, bearer, getApp, lastOtpFor, login, newDevice } from './helpers';
import {
  type Actor,
  type Tenant,
  PASSWORD as STAFF_PASSWORD,
  createInstitute,
  createStaff,
  createSuperAdmin,
  ok,
  purgeInstitutes,
  query,
  send,
} from './security/harness';

/** Password hashing, sign-in lockout and OTP hardening (docs/security.md). Mobiles 9501…. */
const PREFIX = '9501';
let n = 0;
const mobile = () => `${PREFIX}${String(n++).padStart(6, '0')}`;
const PASSWORD = 'Harden@12345';
const WRONG = 'Not-the-password-1';

let superAdmin: Actor;
let tenant: Tenant;

beforeAll(async () => {
  superAdmin = await createSuperAdmin(mobile());
  const tag = `auth${crypto.randomBytes(3).toString('hex')}`;
  tenant = await createInstitute(superAdmin, {
    slug: tag,
    name: `Auth hardening ${tag}`,
    adminMobile: mobile(),
    label: 'admin',
  });
}, 120_000);

afterAll(async () => {
  const users = await query<{ id: number }>('SELECT id FROM users WHERE mobile LIKE ?', [`${PREFIX}%`]);
  if (users.length)
    await AuditEvent.destroy({
      where: {
        action: ['auth.sign_in_locked', 'auth.sign_in_unlocked'],
        entityType: 'user',
        entityId: users.map((u) => String(u.id)),
      },
    });
  await purgeInstitutes([tenant?.id], PREFIX);
}, 120_000);

async function createUser(passwordHash?: string) {
  const m = mobile();
  const user = await User.create({
    name: 'Auth hardening',
    mobile: m,
    email: null,
    passwordHash: passwordHash ?? (await hashPassword(PASSWORD)),
    lastLoginAt: null,
    isSuperAdmin: false,
  });
  return { id: user.id, mobile: m, password: PASSWORD };
}

const post = async (url: string, body: object) =>
  request(await getApp())
    .post(url)
    .send(body);
const signIn = (identifier: string, password: string, device: TestDevice = newDevice()) =>
  post('/api/auth/login', { identifier, password, device });
const outcome = (res: request.Response) => `${res.status} ${res.body.error?.code ?? res.body.status}`;

/** Fails `count` password attempts from new devices and returns the outcomes. */
async function failPasswords(identifier: string, count: number) {
  const outcomes: string[] = [];
  for (let i = 0; i < count; i++) outcomes.push(outcome(await signIn(identifier, WRONG)));
  return outcomes;
}

/** Password accepted: signed in on the first device, OTP next on any other new one. */
const ACCEPTED = /^200 (authenticated|otp_required)$/;
const INVALID = '401 INVALID_CREDENTIALS';
const LOCKED = '429 ACCOUNT_LOCKED';
const lockedAfterFive = [INVALID, INVALID, INVALID, INVALID, LOCKED];

describe('password hashing', () => {
  it('hashes with scrypt, verifies older hashes and flags them for replacement', async () => {
    const hash = await hashPassword('pw-1');
    expect(hash.split('$').slice(0, 4)).toEqual(['scrypt', String(2 ** config.PASSWORD_HASH_COST), '8', '3']);
    expect(await verifyPassword('pw-1', hash)).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword('pw-2', hash)).toEqual({ ok: false, needsRehash: false });

    const legacy = await bcrypt.hash('pw-1', 4);
    expect(await verifyPassword('pw-1', legacy)).toEqual({ ok: true, needsRehash: true });
    expect(await verifyPassword('pw-2', legacy)).toEqual({ ok: false, needsRehash: false });

    const salt = crypto.randomBytes(16);
    const scrypt = (N: number) =>
      ['scrypt', N, 8, 1, salt.toString('base64'), crypto.scryptSync('pw-1', salt, 32, { N, r: 8, p: 1 })]
        .map((p) => (Buffer.isBuffer(p) ? p.toString('base64') : p))
        .join('$');
    expect(await verifyPassword('pw-1', scrypt(2048))).toEqual({ ok: true, needsRehash: true });
    // Parameters beyond the bounds are refused without deriving a key.
    const huge = scrypt(2048).replace(/^scrypt\$2048\$/, `scrypt$${2 ** 24}$`);
    expect(await verifyPassword('pw-1', huge)).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword('pw-1', null)).toEqual({ ok: false, needsRehash: false });
  });

  it('replaces a legacy bcrypt hash at the next successful sign-in', async () => {
    const user = await createUser(await bcrypt.hash(PASSWORD, 4));
    expect(outcome(await signIn(user.mobile, PASSWORD))).toMatch(ACCEPTED);
    const { passwordHash } = (await User.findByPk(user.id))!;
    expect(passwordHash).toMatch(/^scrypt\$/);
    expect(outcome(await signIn(user.mobile, PASSWORD))).toMatch(ACCEPTED);
    expect((await User.findByPk(user.id))!.passwordHash).toBe(passwordHash);
  });
});

describe('sign-in lockout', () => {
  it('locks new devices out after repeated failures but not the devices the user is signed in on', async () => {
    const user = await createUser();
    const known = newDevice();
    await login(user, known);

    const before = Date.now();
    const res: request.Response[] = [];
    for (let i = 0; i < 5; i++) res.push(await signIn(user.mobile, WRONG));
    expect(res.map(outcome)).toEqual(lockedAfterFive);
    expect(res[4].headers['retry-after']).toBe(String(config.LOGIN_LOCKOUT_BASE_SECONDS));
    expect(res[4].body.error.details).toEqual({ retryAfterSeconds: config.LOGIN_LOCKOUT_BASE_SECONDS });
    const until = (await signInLocks([user.id])).get(user.id)!;
    expect(until.getTime()).toBeGreaterThanOrEqual(before + config.LOGIN_LOCKOUT_BASE_SECONDS * 1000);

    // Refused without checking the password, and without extending the lock.
    expect(outcome(await signIn(user.mobile, PASSWORD))).toBe(LOCKED);
    expect(await failPasswords(user.mobile, 3)).toEqual([LOCKED, LOCKED, LOCKED]);
    expect((await signInLocks([user.id])).get(user.id)).toEqual(until);

    expect(outcome(await signIn(user.mobile, PASSWORD, known))).toBe('200 authenticated');
    const audits = await AuditEvent.findAll({
      where: { action: 'auth.sign_in_locked', entityType: 'user', entityId: String(user.id) },
    });
    expect(audits.map((a) => a.metadata)).toEqual([
      { method: 'password', deviceId: null, failures: 5, lockedUntil: until.toISOString() },
    ]);
  });

  it('ends locks by itself, doubles them while failures go on and forgets them after a success', async () => {
    const base = config.LOGIN_LOCKOUT_BASE_SECONDS;
    config.LOGIN_LOCKOUT_BASE_SECONDS = 1;
    try {
      const user = await createUser();
      expect(await failPasswords(user.mobile, 5)).toEqual(lockedAfterFive);
      await sleep(1100);
      const again = await signIn(user.mobile, WRONG);
      expect(outcome(again)).toBe(LOCKED);
      expect(again.headers['retry-after']).toBe('2');
      await sleep(2100);
      expect(outcome(await signIn(user.mobile, PASSWORD))).toMatch(ACCEPTED);
      expect(await signInLocks([user.id])).toEqual(new Map());
      expect(await failPasswords(user.mobile, 4)).toEqual([INVALID, INVALID, INVALID, INVALID]);
    } finally {
      config.LOGIN_LOCKOUT_BASE_SECONDS = base;
    }
  });

  it('locks identifiers without an account the same way', async () => {
    expect(await failPasswords(mobile(), 5)).toEqual(lockedAfterFive);
    expect(await failPasswords(`nobody-${crypto.randomBytes(4).toString('hex')}@example.com`, 6)).toEqual([
      ...lockedAfterFive,
      LOCKED,
    ]);
  });

  it('runs parallel attempts one at a time, so none slips past the lock', async () => {
    const user = await createUser();
    const res = await Promise.all(Array.from({ length: 10 }, () => signIn(user.mobile, WRONG)));
    const outcomes = res.map(outcome);
    expect(outcomes.filter((o) => o === INVALID)).toHaveLength(4);
    expect(outcomes.filter((o) => o === LOCKED)).toHaveLength(6);
  });

  it('counts wrong passwords given to attach an existing account to a registration', async () => {
    const user = await createUser();
    const account = { id: user.id, passwordHash: (await User.findByPk(user.id))!.passwordHash };
    for (let i = 0; i < 4; i++) expect(await confirmAccountPassword(account, WRONG)).toBe(false);
    await expect(confirmAccountPassword(account, WRONG)).rejects.toMatchObject({
      status: 429,
      code: 'ACCOUNT_LOCKED',
    });
    await expect(confirmAccountPassword(account, PASSWORD)).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(outcome(await signIn(user.mobile, PASSWORD))).toBe(LOCKED);
  });

  it('lets institute and platform administrators see and clear a lock', async () => {
    const member = await createStaff(tenant.admin, {
      label: 'member',
      mobile: mobile(),
      permissions: ['students.view'],
      branchId: null,
    });
    const viewer = await createStaff(tenant.admin, {
      label: 'viewer',
      mobile: mobile(),
      permissions: ['users.view'],
      branchId: null,
    });
    const listed = async () => {
      const rows: { id: number; signInLockedUntil: string | null }[] = await ok(
        tenant.admin,
        'GET',
        `/api/users/devices?search=${member.mobile}`,
      );
      const platform: typeof rows = await ok(superAdmin, 'GET', `/api/admin/users?search=${member.mobile}`);
      const until = rows.find((r) => r.id === member.userId)?.signInLockedUntil;
      expect(platform.find((r) => r.id === member.userId)?.signInLockedUntil).toBe(until);
      return until;
    };
    const unlocked = () =>
      AuditEvent.findAll({
        where: { action: 'auth.sign_in_unlocked', entityType: 'user', entityId: String(member.userId) },
        order: [['id', 'ASC']],
      });

    expect(await listed()).toBeNull();
    expect(await failPasswords(member.mobile, 5)).toEqual(lockedAfterFive);
    expect(Date.parse((await listed())!)).toBeGreaterThan(Date.now());

    expect((await send(viewer, 'DELETE', `/api/users/${member.userId}/sign-in-lock`)).status).toBe(403);
    expect((await send(tenant.admin, 'DELETE', `/api/users/${member.userId}/sign-in-lock`)).status).toBe(204);
    expect(await listed()).toBeNull();
    expect(outcome(await signIn(member.mobile, STAFF_PASSWORD))).toBe('200 otp_required');

    expect(await failPasswords(member.mobile, 5)).toEqual(lockedAfterFive);
    expect((await send(superAdmin, 'DELETE', `/api/admin/users/${member.userId}/sign-in-lock`)).status).toBe(
      204,
    );
    expect(await listed()).toBeNull();
    expect((await send(superAdmin, 'DELETE', '/api/admin/users/999999999/sign-in-lock')).status).toBe(404);

    expect(
      (await unlocked()).map((a) => ({ institute: a.instituteId, actor: a.actorUserId, meta: a.metadata })),
    ).toEqual([
      { institute: tenant.id, actor: tenant.admin.userId, meta: { wasLocked: true } },
      { institute: null, actor: superAdmin.userId, meta: { wasLocked: true } },
    ]);
    // Nothing to clear: no audit entry.
    expect((await send(tenant.admin, 'DELETE', `/api/users/${member.userId}/sign-in-lock`)).status).toBe(204);
    expect(await unlocked()).toHaveLength(2);
  });
});

describe('OTP', () => {
  const requestOtp = (m: string, device: TestDevice) => post('/api/auth/otp/request', { mobile: m, device });
  const verify = (challengeId: string, code: string, device: TestDevice) =>
    post('/api/auth/otp/verify', { challengeId, code, device });
  const otherThan = (code: string) => String((Number(code) + 1) % 1e6).padStart(6, '0');

  it('stores codes as an HMAC keyed with OTP_HASH_SECRET', async () => {
    const user = await createUser();
    const device = newDevice();
    const { challengeId } = (await requestOtp(user.mobile, device)).body;
    const code = lastOtpFor(user.mobile);
    const [row] = await query<{ hash: string }>('SELECT code_hash AS hash FROM otp_challenges WHERE id = ?', [
      challengeId,
    ]);
    expect(row.hash).toBe(
      crypto
        .createHmac('sha256', config.OTP_HASH_SECRET)
        .update(`otp:${challengeId}:${user.mobile}:${code}`)
        .digest('hex'),
    );
    expect(outcome(await verify(challengeId, code, device))).toBe('200 authenticated');
  });

  it('answers requests for unknown numbers alike, without storing or sending anything', async () => {
    const user = await createUser();
    const ghost = mobile();
    const real = await requestOtp(user.mobile, newDevice());
    const fake = await requestOtp(ghost, newDevice());
    expect(fake.status).toBe(200);
    expect(Object.keys(fake.body).sort()).toEqual(Object.keys(real.body).sort());
    expect(fake.body).toMatchObject({ status: 'otp_required', reason: 'otp_login' });
    expect(fake.body.maskedMobile).toBe(
      real.body.maskedMobile.replace(user.mobile.slice(-4), ghost.slice(-4)),
    );
    for (const id of [real.body.challengeId, fake.body.challengeId])
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(consoleOutbox.some((m) => m.to === ghost)).toBe(false);
    expect(await query('SELECT id FROM otp_challenges WHERE mobile = ?', [ghost])).toEqual([]);
  });

  it('answers alike when the SMS fails, unless the password was already checked', async () => {
    const user = await createUser();
    expect(outcome(await signIn(user.mobile, PASSWORD))).toBe('200 authenticated');
    const sms = getMessagingProvider('sms');
    setMessagingProvider({ channel: 'sms', name: 'down', send: () => Promise.reject(new Error('SMS down')) });
    try {
      const res = await requestOtp(user.mobile, newDevice());
      expect(outcome(res)).toBe('200 otp_required');
      expect(res.body).toMatchObject({ reason: 'otp_login', challengeId: expect.any(String) });
      // A new device after the right password: the caller knows the account, so the failure shows.
      expect((await signIn(user.mobile, PASSWORD)).status).toBeGreaterThanOrEqual(500);
    } finally {
      setMessagingProvider(sms);
    }
  });

  it('treats wrong codes for unknown numbers like wrong codes for real ones', async () => {
    const user = await createUser();
    const tries = async (m: string, code: () => string) => {
      const device = newDevice();
      const { challengeId } = (await requestOtp(m, device)).body;
      const wrong = otherThan(code());
      const outcomes = [outcome(await verify(challengeId, wrong, newDevice()))];
      for (let i = 0; i < 6; i++) outcomes.push(outcome(await verify(challengeId, wrong, device)));
      outcomes.push(outcome(await verify(challengeId, code(), device)));
      return outcomes;
    };
    const expected = [
      '401 OTP_INVALID', // another device: not counted
      ...lockedAfterFive.map((o) => (o === INVALID ? '401 OTP_INVALID' : o)),
      LOCKED,
      LOCKED,
    ];
    expect(await tries(user.mobile, () => lastOtpFor(user.mobile))).toEqual(expected);
    expect(await tries(mobile(), () => '123456')).toEqual(expected);
    expect(outcome(await verify(crypto.randomUUID(), '123456', newDevice()))).toBe('401 OTP_INVALID');
  });

  it('limits requests per number, with or without an account', async () => {
    const user = await createUser();
    for (const m of [user.mobile, mobile()]) {
      const device = newDevice();
      for (let i = 0; i < config.OTP_REQUESTS_PER_MOBILE; i++)
        expect(outcome(await requestOtp(m, device))).toBe('200 otp_required');
      expect(outcome(await requestOtp(m, newDevice()))).toBe('429 OTP_RATE_LIMITED');
    }
  });
});

describe('biometric unlock', () => {
  it('counts wrong device secrets towards a lock of that device only', async () => {
    const user = await createUser();
    const phone = newDevice('android');
    const session = await login(user, phone);
    const enrolled = await request(await getApp())
      .post('/api/auth/biometric')
      .set(bearer(session.accessToken));
    expect(enrolled.status).toBe(201);
    const { deviceId, secret } = enrolled.body as { deviceId: number; secret: string };
    const unlock = async (body: object) =>
      outcome(await post('/api/auth/biometric/unlock', { deviceId, deviceUid: phone.uid, secret, ...body }));

    const wrongDevice: string[] = [];
    for (let i = 0; i < 6; i++) wrongDevice.push(await unlock({ deviceUid: newDevice().uid }));
    expect(new Set(wrongDevice)).toEqual(new Set(['401 BIOMETRIC_INVALID']));

    const wrongSecret: string[] = [];
    for (let i = 0; i < 5; i++)
      wrongSecret.push(await unlock({ secret: crypto.randomBytes(32).toString('hex') }));
    expect(wrongSecret).toEqual([...Array(4).fill('401 BIOMETRIC_INVALID'), LOCKED]);
    expect(await unlock({})).toBe(LOCKED);
    expect(outcome(await signIn(user.mobile, PASSWORD, phone))).toBe(LOCKED);
    expect(outcome(await signIn(user.mobile, PASSWORD))).toBe('200 otp_required');
    const [locked] = await AuditEvent.findAll({
      where: { action: 'auth.sign_in_locked', entityType: 'user', entityId: String(user.id) },
    });
    expect(locked.metadata).toMatchObject({ method: 'biometric', deviceId, failures: 5 });

    expect((await send(superAdmin, 'DELETE', `/api/admin/users/${user.id}/sign-in-lock`)).status).toBe(204);
    expect(await unlock({})).toBe('200 authenticated');
  });
});
