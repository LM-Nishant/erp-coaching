import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { decryptSecret, maskSecret } from '../src/infrastructure/crypto';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { getDefaultMessagingProvider } from '../src/infrastructure/messaging';
import { setPaymentGatewayHttp, type GatewayHttpRequest } from '../src/infrastructure/payment-gateways';
import { getStorage } from '../src/infrastructure/storage';
import { runWithContext } from '../src/shared/context';
import { credentialsOf, enabledGateways } from '../src/modules/fees/gateways.service';
import { resolveProvider } from '../src/modules/notifications/providers.service';
import { PlatformIntegration } from '../src/modules/platform/models';
import {
  invalidatePlatformIntegrations,
  loadIntegrations,
  resolveSaasGateway,
} from '../src/modules/platform/platform.service';
import { bearer, getApp, login, purgeRows, USERS } from './helpers';

const RUN = Date.now().toString(36);
const STARTED_AT = new Date(Date.now() - 1000);
/** Raw-query replacements format Dates in the process's local zone; the DB stores UTC. */
const utc = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const PASSWORD = 'Password@123';
/** 9422… is this suite's mobile range. */
const mobile = () => `9422${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
const PLATFORM = '/api/admin/platform';
const RZP_SECRET = 'rzp-platform-secret-7731';
const RZP_WEBHOOK = 'rzp-platform-webhook-4410';
const TWILIO_TOKEN = 'twilio-auth-token-9902';
const S3_SECRET = 's3-secret-access-key-5521';

let sa: string;
let T: { id: number; token: string };
let savedRows: Record<string, unknown>[] = [];

const asT = <R>(fn: () => Promise<R>) =>
  runWithContext({ system: true, instituteId: T.id, allowedBranchIds: null }, fn);

const send = async (method: 'get' | 'put' | 'post' | 'delete', path: string, body?: object, token = sa) => {
  const req = request(await getApp())
    [method](path)
    .set(bearer(token));
  return body === undefined ? req : req.send(body);
};
const get = (path: string, token?: string) => send('get', path, undefined, token);
const put = (path: string, body: object, token?: string) => send('put', path, body, token);
const post = (path: string, body: object, token?: string) => send('post', path, body, token);
const del = (path: string, token?: string) => send('delete', path, undefined, token);

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

async function storedRow(kind: string, slot: string) {
  const [row] = await getSequelize().query<{
    enabled: number;
    settings: unknown;
    secrets_encrypted: string | null;
  }>('SELECT enabled, settings, secrets_encrypted FROM platform_integrations WHERE kind = ? AND slot = ?', {
    replacements: [kind, slot],
    type: QueryTypes.SELECT,
  });
  return row;
}

async function lastAudit(action: string, entityId: string | null) {
  const [row] = await getSequelize().query<{ institute_id: number | null; metadata: unknown }>(
    'SELECT institute_id, metadata FROM audit_events WHERE action = ? AND entity_id <=> ? ORDER BY id DESC LIMIT 1',
    { replacements: [action, entityId], type: QueryTypes.SELECT },
  );
  return row ? { instituteId: row.institute_id, metadata: json(row.metadata) } : undefined;
}

async function resetPlatformIntegrations(rows: Record<string, unknown>[]) {
  await PlatformIntegration.destroy({ where: {} });
  if (rows.length) await PlatformIntegration.bulkCreate(rows as never[]);
  invalidatePlatformIntegrations();
  await loadIntegrations(true);
}

beforeAll(async () => {
  sa = (await login(USERS.superAdmin)).accessToken;
  // Start from "nothing configured"; whatever was there is restored afterwards.
  savedRows = (await PlatformIntegration.findAll({ raw: true })) as unknown as Record<string, unknown>[];
  await resetPlatformIntegrations([]);
  const [plan] = await getSequelize().query<{ id: number }>("SELECT id FROM plans WHERE code = 'starter'", {
    type: QueryTypes.SELECT,
  });
  const adminMobile = mobile();
  const res = await post('/api/admin/institutes', {
    name: 'Platform Integrations Test',
    slug: `pi-${RUN}`,
    planId: plan.id,
    state: 'Karnataka',
    admin: { name: 'Integrations Admin', mobile: adminMobile, password: PASSWORD },
  });
  expect(res.status).toBe(201);
  T = { id: res.body.id, token: (await login({ mobile: adminMobile, password: PASSWORD })).accessToken };
});

afterEach(() => setPaymentGatewayHttp(null));

afterAll(async () => {
  const sequelize = getSequelize();
  await resetPlatformIntegrations(savedRows);
  const select = async (sql: string, replacements: unknown[]) =>
    (await sequelize.query<{ id: number }>(sql, { replacements, type: QueryTypes.SELECT })).map((r) => r.id);
  if (T?.id) {
    // Billing documents are kept when an institute is deleted (institute_id → NULL), so remove them first.
    await sequelize.query('DELETE FROM subscription_payments WHERE institute_id = ?', {
      replacements: [T.id],
    });
    await purgeRows(
      'subscription_invoices',
      await select('SELECT id FROM subscription_invoices WHERE institute_id = ?', [T.id]),
    );
    await sequelize.query('DELETE FROM audit_events WHERE institute_id = ?', { replacements: [T.id] });
    await purgeRows('institutes', [T.id]);
  }
  await purgeRows('users', await select("SELECT id FROM users WHERE mobile LIKE '9422%'", []));
  await sequelize.query(
    "DELETE FROM audit_events WHERE institute_id IS NULL AND created_at >= ? AND entity_type IN ('platform_gateway', 'platform_messaging', 'platform_storage')",
    { replacements: [utc(STARTED_AT)] },
  );
});

describe('platform integrations API', () => {
  it('is for super admins only', async () => {
    expect((await request(await getApp()).get(`${PLATFORM}/integrations`)).status).toBe(401);
    expect((await get(`${PLATFORM}/integrations`, T.token)).status).toBe(403);
    expect(
      (
        await put(
          `${PLATFORM}/gateways/mock`,
          { enabled: true, isDefault: true, useForInstitutes: true, sandbox: true },
          T.token,
        )
      ).status,
    ).toBe(403);
  });

  it('lists every gateway, channel and the storage driver', async () => {
    const res = await get(`${PLATFORM}/integrations`);
    expect(res.status).toBe(200);
    expect(res.body.gateways.map((g: { gateway: string }) => g.gateway).sort()).toEqual(
      ['cashfree', 'mock', 'paytm', 'razorpay'].sort(),
    );
    expect(res.body.gateways.every((g: { enabled: boolean }) => !g.enabled)).toBe(true);
    expect(res.body.messaging.map((m: { channel: string }) => m.channel)).toEqual([
      'sms',
      'whatsapp',
      'email',
      'push',
    ]);
    expect(res.body.storage).toMatchObject({ active: false, effectiveDriver: 'local', envDriver: 'local' });
  });
});

describe('SaaS payment gateways', () => {
  const RZP = `${PLATFORM}/gateways/razorpay`;
  const razorpay = (o: object = {}) => ({
    enabled: false,
    isDefault: false,
    useForInstitutes: false,
    sandbox: true,
    merchantId: 'rzp_platform',
    ...o,
  });

  it('stores secrets encrypted and never returns or audits them', async () => {
    const res = await put(RZP, razorpay({ secretKey: RZP_SECRET, webhookSecret: RZP_WEBHOOK }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      gateway: 'razorpay',
      enabled: false,
      merchantId: 'rzp_platform',
      hasSecret: true,
      keyHint: maskSecret(RZP_SECRET),
      hasWebhookSecret: true,
      lastTestOk: null,
    });
    expect(res.body.webhookUrl).toMatch(/\/api\/subscriptions\/public\/webhooks\/razorpay$/);
    const listed = await get(`${PLATFORM}/integrations`);
    for (const text of [JSON.stringify(res.body), JSON.stringify(listed.body)]) {
      expect(text).not.toContain(RZP_SECRET);
      expect(text).not.toContain(RZP_WEBHOOK);
    }

    const row = await storedRow('gateway', 'razorpay');
    expect(row.secrets_encrypted).toBeTruthy();
    expect(row.secrets_encrypted).not.toContain(RZP_SECRET);
    expect(JSON.stringify(row.settings)).not.toContain(RZP_SECRET);
    expect(JSON.parse(decryptSecret(row.secrets_encrypted!))).toEqual({
      secretKey: RZP_SECRET,
      webhookSecret: RZP_WEBHOOK,
    });

    const audit = await lastAudit('platform.gateway_updated', 'razorpay');
    expect(audit?.instituteId).toBeNull();
    expect(audit?.metadata).toMatchObject({ secretChanged: true, webhookSecretChanged: true });
    expect(JSON.stringify(audit?.metadata)).not.toContain(RZP_SECRET);
  });

  it('keeps stored secrets when the form leaves them blank', async () => {
    const res = await put(RZP, razorpay({ merchantId: 'rzp_platform_2', secretKey: '', webhookSecret: ' ' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      merchantId: 'rzp_platform_2',
      hasSecret: true,
      keyHint: maskSecret(RZP_SECRET),
      hasWebhookSecret: true,
    });
    expect((await lastAudit('platform.gateway_updated', 'razorpay'))?.metadata).toMatchObject({
      secretChanged: false,
      webhookSecretChanged: false,
    });
  });

  it('enables a gateway only after its connection test passes', async () => {
    // Razorpay answers the read-only connection check with 401: the keys are wrong.
    const calls: GatewayHttpRequest[] = [];
    setPaymentGatewayHttp(async (req) => {
      calls.push(req);
      return { status: 401, body: JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR' } }) };
    });
    const enable = await put(RZP, razorpay({ enabled: true }));
    expect(enable.status).toBe(409);
    expect(enable.body.error.code).toBe('INTEGRATION_TEST_FAILED');
    expect(enable.body.error.message).toContain('Razorpay rejected the key ID or key secret');
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.razorpay.com/v1/orders?count=1' });
    expect(calls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from(`rzp_platform:${RZP_SECRET}`).toString('base64')}`,
    );

    const test = await post(`${RZP}/test`, {});
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(false);
    const listed = (await get(`${PLATFORM}/integrations`)).body.gateways.find(
      (g: { gateway: string }) => g.gateway === 'razorpay',
    );
    // The failed enable saved nothing (merchant id unchanged); the explicit test recorded its result.
    expect(listed).toMatchObject({ enabled: false, merchantId: 'rzp_platform_2', lastTestOk: false });

    const noSecret = await put(`${PLATFORM}/gateways/cashfree`, razorpay({ enabled: true }));
    expect(noSecret.status).toBe(400);
    expect((await put(`${PLATFORM}/gateways/stripe`, razorpay())).status).toBe(404);
  });

  it('serves SaaS checkout from the default enabled gateway', async () => {
    const res = await put(`${PLATFORM}/gateways/mock`, {
      enabled: true,
      isDefault: true,
      useForInstitutes: true,
      sandbox: true,
      merchantId: 'platform-mock',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      isDefault: true,
      useForInstitutes: true,
      lastTestOk: true,
    });
    expect(res.body.lastTestMessage).toMatch(/Created test order/);

    await expect(resolveSaasGateway({ purpose: 'checkout' })).resolves.toMatchObject({
      gateway: 'mock',
      credentials: { merchantId: 'platform-mock', sandbox: true },
    });
    await expect(resolveSaasGateway({ gateway: 'razorpay', purpose: 'checkout' })).resolves.toBeNull();
    // Disabled gateways still verify payments started before they were switched off.
    await expect(resolveSaasGateway({ gateway: 'razorpay', purpose: 'verify' })).resolves.toMatchObject({
      gateway: 'razorpay',
      credentials: { secretKey: RZP_SECRET },
    });
  });
});

describe('institute fee gateways', () => {
  const managed = async () =>
    (await asT(() => enabledGateways())).map((r) => [r.gateway, r.platformManaged] as const);

  it('fall back to the gateway the platform offers', async () => {
    const rows = await asT(() => enabledGateways());
    expect(rows.map((r) => [r.gateway, r.platformManaged])).toEqual([['mock', true]]);
    expect(credentialsOf(rows[0])).toMatchObject({ merchantId: 'platform-mock' });

    const listed = await get('/api/fees/gateways', T.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ gateway: 'mock', enabled: true, platformManaged: true, keyHint: null }),
    ]);
  });

  it("prefer the institute's own enabled gateway", async () => {
    const own = await put(
      '/api/fees/gateways/razorpay',
      { enabled: true, merchantId: 'inst-rzp', secretKey: 'inst-secret-3141' },
      T.token,
    );
    expect(own.status).toBe(200);
    expect(own.body.platformManaged).toBe(false);
    const rows = await asT(() => enabledGateways());
    expect(rows.map((r) => r.gateway)).toEqual(['razorpay']);
    expect(credentialsOf(rows[0])).toMatchObject({ merchantId: 'inst-rzp', secretKey: 'inst-secret-3141' });

    expect((await put('/api/fees/gateways/razorpay', { enabled: false }, T.token)).status).toBe(200);
    expect(await managed()).toEqual([['mock', true]]);
  });

  it('stop falling back once the platform withdraws its gateway', async () => {
    const res = await put(`${PLATFORM}/gateways/mock`, {
      enabled: true,
      isDefault: true,
      useForInstitutes: false,
      sandbox: true,
    });
    expect(res.status).toBe(200);
    // Same connection: no re-test needed and the merchant id is kept.
    expect(res.body).toMatchObject({
      useForInstitutes: false,
      merchantId: 'platform-mock',
      lastTestOk: true,
    });
    expect(await managed()).toEqual([]);
  });
});

describe('notification providers', () => {
  const SMS = `${PLATFORM}/messaging/sms`;
  const twilio = { accountSid: 'AC-platform-1', from: '+15550001111' };
  const sendVia = (to: string) =>
    asT(async () => (await resolveProvider('sms')).provider.send({ to, body: 'Integration test' }));

  it('store secrets encrypted and return only masked hints', async () => {
    const res = await put(SMS, {
      provider: 'twilio',
      enabled: false,
      settings: { ...twilio, authToken: TWILIO_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      channel: 'sms',
      provider: 'twilio',
      enabled: false,
      configured: true,
      settings: twilio,
      secretHints: { authToken: maskSecret(TWILIO_TOKEN) },
    });
    expect(JSON.stringify((await get(`${PLATFORM}/integrations`)).body)).not.toContain(TWILIO_TOKEN);

    const row = await storedRow('messaging', 'sms');
    expect(JSON.stringify(row.settings)).not.toContain(TWILIO_TOKEN);
    expect(JSON.parse(decryptSecret(row.secrets_encrypted!))).toEqual({ authToken: TWILIO_TOKEN });

    const audit = await lastAudit('platform.messaging_updated', 'sms');
    expect(audit?.metadata).toMatchObject({ provider: 'twilio', secretsChanged: ['authToken'] });
    expect(JSON.stringify(audit?.metadata)).not.toContain(TWILIO_TOKEN);
  });

  it('need a successful test message before they are enabled', async () => {
    const untested = await put(SMS, { provider: 'twilio', enabled: true, settings: twilio });
    expect(untested.status).toBe(409);
    expect(untested.body.error.code).toBe('INTEGRATION_TEST_REQUIRED');
    const failing = await put(SMS, {
      provider: 'twilio',
      enabled: true,
      settings: twilio,
      testTo: '+919422000000',
    });
    expect(failing.status).toBe(409);
    expect(failing.body.error.code).toBe('INTEGRATION_TEST_FAILED');
    expect((await storedRow('messaging', 'sms')).enabled).toBeFalsy();

    expect((await put(`${PLATFORM}/messaging/whatsapp`, { provider: 'smtp', enabled: false })).status).toBe(
      400,
    );
    expect((await put(`${PLATFORM}/messaging/whatsapp`, { provider: 'pigeon', enabled: false })).status).toBe(
      400,
    );
    expect(
      (
        await put(`${PLATFORM}/messaging/whatsapp`, {
          provider: 'twilio',
          enabled: false,
          settings: { from: '+1' },
        })
      ).status,
    ).toBe(400);
    expect((await put(`${PLATFORM}/messaging/fax`, { provider: 'console', enabled: false })).status).toBe(
      404,
    );
  });

  it('are the default for institutes without a provider of their own', async () => {
    const res = await put(SMS, {
      provider: 'console',
      enabled: true,
      settings: { failPattern: 'FAILME' },
      testTo: '9422000000',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: 'console',
      enabled: true,
      settings: { failPattern: 'FAILME' },
      secretHints: {},
      lastTestOk: true,
    });
    // Switching provider drops the previous provider's credentials.
    expect((await storedRow('messaging', 'sms')).secrets_encrypted).toBeNull();

    await expect(
      (await getDefaultMessagingProvider('sms')).send({ to: 'FAILME-1', body: 'x' }),
    ).rejects.toThrow(/delivery failure/);
    await expect(sendVia('FAILME-2')).rejects.toThrow(/delivery failure/);
    const test = await post('/api/notifications/providers/sms/test', { to: 'FAILME-3' }, T.token);
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(false);
  });

  it("give way to the institute's own provider", async () => {
    const own = await put(
      '/api/notifications/providers/sms',
      { provider: 'console', isActive: true, settings: {} },
      T.token,
    );
    expect(own.status).toBe(200);
    await expect(sendVia('FAILME-4')).resolves.toMatchObject({ status: 'sent' });
    const test = await post('/api/notifications/providers/sms/test', { to: 'FAILME-5' }, T.token);
    expect(test.body.ok).toBe(true);
  });

  it('fall back to the built-in provider once removed', async () => {
    const res = await del(SMS);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: false, enabled: false });
    expect(await storedRow('messaging', 'sms')).toBeUndefined();
    expect(await lastAudit('platform.messaging_removed', 'sms')).toBeDefined();
    await expect(
      (await getDefaultMessagingProvider('sms')).send({ to: 'FAILME-6', body: 'x' }),
    ).resolves.toMatchObject({ status: 'sent' });
  });
});

describe('file storage', () => {
  const STORAGE = `${PLATFORM}/storage`;
  const s3 = {
    driver: 's3',
    active: false,
    bucket: 'erp-test-bucket',
    region: 'ap-south-1',
    endpoint: 'https://s3.example.test',
    accessKeyId: 'AKIATEST',
  };

  it('stores the secret encrypted; omitted fields keep their saved values', async () => {
    const res = await put(STORAGE, { ...s3, secretAccessKey: S3_SECRET });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      driver: 's3',
      active: false,
      bucket: 'erp-test-bucket',
      endpoint: 'https://s3.example.test',
      hasSecret: true,
      secretHint: maskSecret(S3_SECRET),
      effectiveDriver: 'local',
    });
    expect(JSON.stringify(res.body)).not.toContain(S3_SECRET);
    const row = await storedRow('storage', 'default');
    expect(JSON.parse(decryptSecret(row.secrets_encrypted!))).toEqual({ secretAccessKey: S3_SECRET });
    const audit = await lastAudit('platform.storage_updated', null);
    expect(audit?.metadata).toMatchObject({ driver: 's3', secretChanged: true });
    expect(JSON.stringify(audit?.metadata)).not.toContain(S3_SECRET);

    const again = await put(STORAGE, { driver: 's3', active: false, region: 'eu-west-1' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      bucket: 'erp-test-bucket',
      region: 'eu-west-1',
      endpoint: 'https://s3.example.test',
      accessKeyId: 'AKIATEST',
      hasSecret: true,
    });
  });

  it('refuses to activate a driver whose connection test fails', async () => {
    const res = await put(STORAGE, { driver: 's3', active: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_TEST_FAILED');
    expect(getStorage().driver).toBe('local');
    expect((await put(STORAGE, { driver: 's3', active: true, bucket: null })).status).toBe(400);
    expect((await post(`${STORAGE}/test`, {})).body.ok).toBe(false);
  });

  it('activates local disk storage', async () => {
    const res = await put(STORAGE, { driver: 'local', active: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      driver: 'local',
      active: true,
      bucket: null,
      hasSecret: false,
      effectiveDriver: 'local',
      lastTestOk: true,
    });
    const test = await post(`${STORAGE}/test`, {});
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(true);
  });
});
