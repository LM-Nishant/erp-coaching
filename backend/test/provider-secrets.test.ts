/**
 * Stored provider secrets (AI API key, platform gateway/messaging/storage secrets, institute
 * messaging secrets) are only reused with the destination they were saved for: changing the
 * provider, base URL, SMTP host, storage endpoint/bucket/driver or gateway environment without
 * re-entering the secret is refused with 400 SECRET_REQUIRED, on save and on "test connection".
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { AiSetting } from '../src/modules/ai/models';
import { PlatformIntegration } from '../src/modules/platform/models';
import { invalidatePlatformIntegrations, loadIntegrations } from '../src/modules/platform/platform.service';
import { bearer, getApp, login, purgeRows, USERS } from './helpers';

const RUN = Date.now().toString(36);
const PASSWORD = 'Password@123';
/** 948… is this suite's mobile range. */
const mobile = () => `948${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
const PLATFORM = '/api/admin/platform';
const AI = '/api/admin/ai/settings';
/** Nothing listens here: connection tests fail fast without leaving the machine. */
const DEAD_URL = 'http://127.0.0.1:9/v1';

let sa: string;
let T: { id: number; token: string };
let savedRows: Record<string, unknown>[] = [];
let savedAi: Record<string, unknown> | null = null;

async function send(method: 'put' | 'post', path: string, body: object, token = sa) {
  return request(await getApp())
    [method](path)
    .set(bearer(token))
    .send(body);
}

const expectSecretRequired = (res: request.Response, fields: string[]) => {
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('SECRET_REQUIRED');
  expect(res.body.error.details).toMatchObject({ fields });
};

async function resetPlatformIntegrations(rows: Record<string, unknown>[]) {
  await PlatformIntegration.destroy({ where: {} });
  if (rows.length) await PlatformIntegration.bulkCreate(rows as never[]);
  invalidatePlatformIntegrations();
  await loadIntegrations(true);
}

beforeAll(async () => {
  sa = (await login(USERS.superAdmin)).accessToken;
  savedRows = (await PlatformIntegration.findAll({ raw: true })) as unknown as Record<string, unknown>[];
  await resetPlatformIntegrations([]);
  savedAi = (await AiSetting.findOne({ where: { scope: 'global' }, raw: true })) as Record<
    string,
    unknown
  > | null;

  const [plan] = await getSequelize().query<{ id: number }>("SELECT id FROM plans WHERE code = 'starter'", {
    type: QueryTypes.SELECT,
  });
  const adminMobile = mobile();
  const res = await send('post', '/api/admin/institutes', {
    name: 'Provider Secrets Test',
    slug: `ps-${RUN}`,
    planId: plan.id,
    admin: { name: 'Secrets Admin', mobile: adminMobile, password: PASSWORD },
  });
  expect(res.status).toBe(201);
  T = { id: res.body.id, token: (await login({ mobile: adminMobile, password: PASSWORD })).accessToken };
});

afterAll(async () => {
  const sequelize = getSequelize();
  await resetPlatformIntegrations(savedRows);
  const current = await AiSetting.findOne({ where: { scope: 'global' } });
  if (savedAi) {
    if (current) await current.update(savedAi as never);
    else await AiSetting.create(savedAi as never);
  } else if (current) await current.destroy();
  if (T?.id) {
    await sequelize.query('DELETE FROM subscription_payments WHERE institute_id = ?', {
      replacements: [T.id],
    });
    const invoices = await sequelize.query<{ id: number }>(
      'SELECT id FROM subscription_invoices WHERE institute_id = ?',
      { replacements: [T.id], type: QueryTypes.SELECT },
    );
    await purgeRows(
      'subscription_invoices',
      invoices.map((r) => r.id),
    );
    await sequelize.query('DELETE FROM audit_events WHERE institute_id = ?', { replacements: [T.id] });
    await purgeRows('institutes', [T.id]);
  }
  const users = await sequelize.query<{ id: number }>("SELECT id FROM users WHERE mobile LIKE '948%'", {
    type: QueryTypes.SELECT,
  });
  await purgeRows(
    'users',
    users.map((r) => r.id),
  );
});

describe('AI provider key', () => {
  const openai = { provider: 'openai', baseUrl: DEAD_URL, model: 'gpt-test', jsonMode: true };
  const KEY = 'sk-provider-secrets-test-1234';

  it('keeps the stored key while the provider and base URL are unchanged', async () => {
    const saved = await send('put', AI, { ...openai, apiKey: KEY });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ hasKey: true, keySource: 'database' });

    const again = await send('put', AI, { ...openai, baseUrl: `${DEAD_URL}/`, model: 'gpt-other' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ hasKey: true, model: 'gpt-other' });

    const test = await send('post', `${AI}/test`, openai);
    expect(test.status).toBe(200);
    // The stored key was used: the call reached the (dead) URL instead of asking for a key.
    expect(test.body.ok).toBe(false);
    expect(test.body.message).not.toBe('Enter an API key for this provider');
  });

  it('refuses to send the stored key to another base URL or provider', async () => {
    expectSecretRequired(
      await send('post', `${AI}/test`, { ...openai, baseUrl: 'https://evil.example.test/v1' }),
      ['baseUrl'],
    );
    expectSecretRequired(await send('post', `${AI}/test`, { provider: 'groq' }), ['provider']);
    expectSecretRequired(await send('put', AI, { ...openai, baseUrl: 'https://evil.example.test/v1' }), [
      'baseUrl',
    ]);
    const unchanged = await request(await getApp())
      .get(AI)
      .set(bearer(sa));
    expect(unchanged.body).toMatchObject({ baseUrl: DEAD_URL, hasKey: true });

    // A re-entered key may go anywhere.
    const test = await send('post', `${AI}/test`, {
      ...openai,
      baseUrl: 'http://127.0.0.1:9/other',
      apiKey: 'sk-new',
    });
    expect(test.status).toBe(200);
    expect(test.body.message).not.toBe('Enter an API key for this provider');
  });

  it('drops the stored key when a key-less provider points elsewhere', async () => {
    const ollama = await send('put', AI, {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:9/ollama',
      model: 'llama3',
      jsonMode: true,
    });
    expect(ollama.status).toBe(200);
    expect(ollama.body).toMatchObject({ hasKey: false, keySource: 'none' });
    expect((await AiSetting.findOne({ where: { scope: 'global' } }))?.apiKeyEncrypted).toBeNull();
  });
});

describe('platform integrations', () => {
  it('payment gateway: switching sandbox/live needs the secret key again', async () => {
    const RZP = `${PLATFORM}/gateways/razorpay`;
    const form = {
      enabled: false,
      isDefault: false,
      useForInstitutes: false,
      sandbox: true,
      merchantId: 'rzp_ps',
    };
    expect((await send('put', RZP, { ...form, secretKey: 'rzp-secret-ps-1' })).status).toBe(200);
    expect((await send('put', RZP, { ...form, merchantId: 'rzp_ps_2' })).status).toBe(200);

    expectSecretRequired(await send('post', `${RZP}/test`, { sandbox: false }), ['sandbox']);
    expectSecretRequired(await send('put', RZP, { ...form, sandbox: false }), ['sandbox']);
    const ok = await send('put', RZP, { ...form, sandbox: false, secretKey: 'rzp-live-secret-ps' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ sandbox: false, hasSecret: true });
  });

  it('storage: a new endpoint, bucket or driver needs the secret access key again', async () => {
    const STORAGE = `${PLATFORM}/storage`;
    const s3 = {
      driver: 's3',
      active: false,
      bucket: 'ps-bucket',
      region: 'ap-south-1',
      endpoint: 'https://s3.example.test',
      accessKeyId: 'AKIAPS',
    };
    expect((await send('put', STORAGE, { ...s3, secretAccessKey: 's3-secret-ps' })).status).toBe(200);
    // Region alone stays with the same service: the stored secret is kept.
    expect((await send('put', STORAGE, { driver: 's3', active: false, region: 'eu-west-1' })).status).toBe(
      200,
    );

    expectSecretRequired(await send('post', `${STORAGE}/test`, { endpoint: 'https://evil.example.test' }), [
      'endpoint',
    ]);
    expectSecretRequired(
      await send('put', STORAGE, { driver: 's3', active: false, bucket: 'other-bucket' }),
      ['bucket'],
    );
    expectSecretRequired(await send('post', `${STORAGE}/test`, { driver: 'r2' }), ['driver']);
    const ok = await send('put', STORAGE, {
      driver: 's3',
      active: false,
      endpoint: 'https://s3-2.example.test',
      secretAccessKey: 's3-secret-ps-2',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ endpoint: 'https://s3-2.example.test', hasSecret: true });
  });

  it('messaging: a new SMTP server needs the password again', async () => {
    const EMAIL = `${PLATFORM}/messaging/email`;
    const smtp = { host: 'smtp.example.test', port: '587', user: 'mailer', from: 'erp@example.test' };
    const saved = await send('put', EMAIL, {
      provider: 'smtp',
      enabled: false,
      settings: { ...smtp, password: 'smtp-pass-ps' },
    });
    expect(saved.status).toBe(200);
    expect(
      (await send('put', EMAIL, { provider: 'smtp', enabled: false, settings: { ...smtp, user: 'm2' } }))
        .status,
    ).toBe(200);

    expectSecretRequired(
      await send('post', `${EMAIL}/test`, { settings: { host: 'evil.example.test' }, to: 'a@example.test' }),
      ['host'],
    );
    expectSecretRequired(
      await send('put', EMAIL, { provider: 'smtp', enabled: false, settings: { ...smtp, port: '2525' } }),
      ['port'],
    );
  });
});

describe('institute notification providers', () => {
  it('a new SMTP server needs the password again', async () => {
    const EMAIL = '/api/notifications/providers/email';
    const smtp = { host: 'smtp.example.test', port: '587', user: 'mailer', from: 'erp@example.test' };
    const body = (settings: object) => ({ provider: 'smtp', isActive: false, settings });
    expect((await send('put', EMAIL, body({ ...smtp, password: 'smtp-pass-inst' }), T.token)).status).toBe(
      200,
    );
    expect((await send('put', EMAIL, body({ ...smtp, from: 'other@example.test' }), T.token)).status).toBe(
      200,
    );

    expectSecretRequired(await send('put', EMAIL, body({ ...smtp, host: 'evil.example.test' }), T.token), [
      'host',
    ]);
    const ok = await send(
      'put',
      EMAIL,
      body({ ...smtp, host: 'smtp2.example.test', password: 'p2' }),
      T.token,
    );
    expect(ok.status).toBe(200);
  });
});
