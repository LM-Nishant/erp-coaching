import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/infrastructure/config';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import { Device, clearSignInLock } from '../src/modules/authentication/api';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { type TestDevice, getApp, newDevice } from './helpers';
import {
  PASSWORD,
  type Tenant,
  createInstitute,
  createSuperAdmin,
  ok,
  purgeInstitutes,
  query,
} from './security/harness';

/**
 * AUTH_DEV_SKIP_OTP (local development): sign-in without OTPs, everything else as usual. Mobiles 960….
 */
const PREFIX = '960';
const RUN = String(crypto.randomInt(1000)).padStart(3, '0');
let n = 0;
const mobile = () => `${PREFIX}${RUN}${String(n++).padStart(4, '0')}`;

const post = async (url: string, body: object) =>
  request(await getApp())
    .post(url)
    .send(body);
const outcome = (res: request.Response) => `${res.status} ${res.body.error?.code ?? res.body.status}`;
const codesTo = (m: string) => consoleOutbox.filter((x) => x.to === m && x.data?.otp).length;
const me = async (token: string) => (await ok(token, 'GET', '/api/auth/me')).user;

describe('sign-in with AUTH_DEV_SKIP_OTP', () => {
  let tenant: Tenant;
  const adminMobile = mobile();
  const shared = mobile();
  const single = mobile();
  let owner: { userId: number };
  let sibling: { userId: number };
  let only: { userId: number };

  beforeAll(async () => {
    const superAdmin = await createSuperAdmin(mobile());
    const tag = crypto.randomBytes(3).toString('hex');
    tenant = await createInstitute(superAdmin, {
      slug: `dso${tag}`,
      name: `Dev OTP ${tag}`,
      adminMobile,
      label: 'admin',
    });
    const addStudent = (name: string, m: string) =>
      ok(tenant.admin, 'POST', '/api/students', {
        name,
        mobile: m,
        branchId: tenant.mainBranchId,
        allowDuplicate: true,
      });
    owner = await addStudent('Owner Dev', shared);
    sibling = await addStudent('Sibling Dev', shared);
    only = await addStudent('Only Dev', single);
    config.AUTH_DEV_SKIP_OTP = true;
  }, 120_000);

  afterAll(async () => {
    config.AUTH_DEV_SKIP_OTP = false;
    const users = await query<{ id: number }>(
      'SELECT id FROM users WHERE mobile LIKE ? OR shared_mobile LIKE ?',
      [`${PREFIX}${RUN}%`, `${PREFIX}${RUN}%`],
    );
    if (users.length) {
      const userIds = users.map((u) => u.id);
      const devices = await Device.findAll({ where: { userId: userIds }, attributes: ['id', 'deviceUid'] });
      // Sign-in, lock and device events are platform-wide (no institute), so purgeInstitutes leaves them.
      await AuditEvent.destroy({
        where: { instituteId: null, entityType: 'user', entityId: userIds.map(String) },
      });
      if (devices.length) {
        await AuditEvent.destroy({
          where: { instituteId: null, entityType: 'device', entityId: devices.map((d) => String(d.id)) },
        });
        await getSequelize().query('DELETE FROM notification_push_tokens WHERE device_uid IN (?)', {
          replacements: [devices.map((d) => d.deviceUid)],
        });
      }
    }
    await purgeInstitutes([tenant?.id], `${PREFIX}${RUN}`);
    await getSequelize().query('DELETE FROM otp_challenges WHERE mobile LIKE ?', {
      replacements: [`${PREFIX}${RUN}%`],
    });
  }, 120_000);

  const login = (device: TestDevice, password = PASSWORD) =>
    post('/api/auth/login', { identifier: adminMobile, password, device });

  it('signs a password in on a new device without the OTP, registering it within the device limit', async () => {
    config.AUTH_DEV_SKIP_OTP = false;
    expect(outcome(await login(newDevice()))).toBe('200 otp_required');
    config.AUTH_DEV_SKIP_OTP = true;

    const sent = codesTo(adminMobile);
    const device = newDevice();
    const res = await login(device);
    expect(outcome(res)).toBe('200 authenticated');
    expect(codesTo(adminMobile)).toBe(sent);
    expect(await Device.count({ where: { deviceUid: device.uid, status: 'active' } })).toBe(1);

    const active = await Device.count({ where: { userId: tenant.admin.userId, status: 'active' } });
    expect(active).toBe(config.MAX_ACTIVE_DEVICES);
    expect(outcome(await login(newDevice()))).toBe('200 device_limit_reached');
    expect(outcome(await login(newDevice(), 'Not-the-password-1'))).toBe('401 INVALID_CREDENTIALS');
  });

  it('signs a mobile in without a code or SMS', async () => {
    const res = await post('/api/auth/otp/request', { mobile: single, device: newDevice() });
    expect(outcome(res)).toBe('200 authenticated');
    expect(codesTo(single)).toBe(0);
    expect((await me(res.body.accessToken)).id).toBe(only.userId);
    const [event] = await query<{ metadata: string | object }>(
      "SELECT metadata FROM audit_events WHERE action = 'auth.login' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      [String(only.userId)],
    );
    const metadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
    expect(metadata).toMatchObject({ method: 'otp', purpose: 'login', otpSkipped: true });

    // A number without an account still gets the usual (decoy) challenge.
    expect(outcome(await post('/api/auth/otp/request', { mobile: mobile(), device: newDevice() }))).toBe(
      '200 otp_required',
    );
  });

  it('offers "Who\'s signing in?" without a code, also to switch profile', async () => {
    const device = newDevice();
    const offered = await post('/api/auth/otp/request', { mobile: shared, device });
    expect(outcome(offered)).toBe('200 choose_profile');
    expect(codesTo(shared)).toBe(0);
    expect(offered.body.profiles.map((p: { id: number }) => p.id)).toEqual([owner.userId, sibling.userId]);
    const first = await post('/api/auth/select-profile', {
      selectionToken: offered.body.selectionToken,
      userId: owner.userId,
      device,
    });
    expect(outcome(first)).toBe('200 authenticated');
    expect((await me(first.body.accessToken)).profileCount).toBe(2);

    // "Switch profile" on the same device: the number again, then the sibling.
    const again = await post('/api/auth/otp/request', { mobile: shared, device });
    expect(outcome(again)).toBe('200 choose_profile');
    const switched = await post('/api/auth/select-profile', {
      selectionToken: again.body.selectionToken,
      userId: sibling.userId,
      device,
    });
    expect(outcome(switched)).toBe('200 authenticated');
    expect((await me(switched.body.accessToken)).id).toBe(sibling.userId);
  });

  it('keeps sign-in locks', async () => {
    const outcomes = [];
    for (let i = 0; i < config.LOGIN_LOCKOUT_THRESHOLD; i++)
      outcomes.push(outcome(await login(newDevice(), 'Not-the-password-1')));
    expect(outcomes.at(-1)).toBe('429 ACCOUNT_LOCKED');
    try {
      expect(outcome(await post('/api/auth/otp/request', { mobile: adminMobile, device: newDevice() }))).toBe(
        '429 ACCOUNT_LOCKED',
      );
    } finally {
      await clearSignInLock(tenant.admin.userId);
    }
  });
});

// Last: reloading the config loads fresh copies of the modules, which must not reach the app above.
describe('config', () => {
  const keys = ['NODE_ENV', 'AUTH_DEV_SKIP_OTP', 'PUBLIC_WEB_URL', 'PASSWORD_HASH_COST'];
  const productionSecrets = {
    JWT_ACCESS_SECRET: 'p'.repeat(32),
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    FILE_URL_SECRET: 'f'.repeat(32),
    OTP_HASH_SECRET: 'o'.repeat(32),
  };
  const saved = Object.fromEntries(
    [...keys, ...Object.keys(productionSecrets)].map((k) => [k, process.env[k]]),
  );

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  /** A fresh copy of the config for `env` (blank = unset, so backend/.env can't set it either). */
  async function load(env: Record<string, string>) {
    Object.assign(process.env, { AUTH_DEV_SKIP_OTP: '' }, env);
    vi.resetModules();
    return (await import('../src/infrastructure/config')).config;
  }

  it('is on by default in development only', async () => {
    expect((await load({ NODE_ENV: 'development' })).AUTH_DEV_SKIP_OTP).toBe(true);
    expect((await load({ NODE_ENV: 'test' })).AUTH_DEV_SKIP_OTP).toBe(false);
    expect((await load({ NODE_ENV: 'development', AUTH_DEV_SKIP_OTP: 'false' })).AUTH_DEV_SKIP_OTP).toBe(
      false,
    );
  });

  it('refuses to start with it on in production', async () => {
    const production = {
      ...productionSecrets,
      NODE_ENV: 'production',
      PUBLIC_WEB_URL: 'https://app.example.com',
      PASSWORD_HASH_COST: '15',
    };
    expect((await load(production)).AUTH_DEV_SKIP_OTP).toBe(false);
    await expect(load({ ...production, AUTH_DEV_SKIP_OTP: 'true' })).rejects.toThrow(
      'AUTH_DEV_SKIP_OTP must not be enabled in production',
    );
  });
});
