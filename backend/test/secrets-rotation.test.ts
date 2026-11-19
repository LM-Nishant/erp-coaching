/**
 * ENCRYPTION_KEY rotation: stored secrets name the key that encrypted them, previous keys keep
 * decrypting, and `secrets:reencrypt` (reencryptStoredSecrets) moves every registered column to the
 * current key and re-keys the platform integration test fingerprints. The suite ends with every
 * stored secret back on the test key, since other suites share the database.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initModels } from '../src/bootstrap';
import { config } from '../src/infrastructure/config';
import { decryptSecret, encryptionKeys, encryptSecret, secretKeyId } from '../src/infrastructure/crypto';
import { encryptedColumns, reencryptStoredSecrets } from '../src/infrastructure/database/encrypted-columns';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { AiSetting } from '../src/modules/ai/models';
import { PlatformIntegration } from '../src/modules/platform/models';
import {
  invalidatePlatformIntegrations,
  loadIntegrations,
  saveGateway,
  testGatewayConfig,
} from '../src/modules/platform/platform.service';

const KEY_A = config.ENCRYPTION_KEY;
const KEY_B = crypto.randomBytes(32).toString('base64');
const PREVIOUS = config.ENCRYPTION_PREVIOUS_KEYS;

function useKeys(current: string, previous = '') {
  config.ENCRYPTION_KEY = current;
  config.ENCRYPTION_PREVIOUS_KEYS = previous;
}

/** A value as stored before key ids existed. */
function v1(plain: string, key: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => p.toString('base64')).join(':');
}

let savedRows: Record<string, unknown>[] = [];
let savedAi: Record<string, unknown> | null = null;

async function resetPlatformIntegrations(rows: Record<string, unknown>[]) {
  await PlatformIntegration.destroy({ where: {} });
  if (rows.length) await PlatformIntegration.bulkCreate(rows as never[]);
  invalidatePlatformIntegrations();
  await loadIntegrations(true);
}

beforeAll(async () => {
  await initModels();
  savedRows = (await PlatformIntegration.findAll({ raw: true })) as unknown as Record<string, unknown>[];
  savedAi = (await AiSetting.findOne({ where: { scope: 'global' }, raw: true })) as Record<
    string,
    unknown
  > | null;
  await resetPlatformIntegrations([]);
});

afterAll(async () => {
  useKeys(KEY_A, PREVIOUS);
  await resetPlatformIntegrations(savedRows);
  await AiSetting.destroy({ where: { scope: 'global' } });
  if (savedAi) await AiSetting.create(savedAi as never);
});

describe('key ring', () => {
  it('writes the current key id and decrypts values of previous keys', () => {
    const a = encryptSecret('alpha');
    expect(a).toMatch(/^v2:[\w-]{8}:/);
    expect(secretKeyId(a)).toBe(encryptionKeys().current.id);
    try {
      useKeys(KEY_B, KEY_A);
      const b = encryptSecret('beta');
      expect(secretKeyId(b)).not.toBe(secretKeyId(a));
      expect([decryptSecret(a), decryptSecret(b)]).toEqual(['alpha', 'beta']);

      useKeys(KEY_B);
      expect(() => decryptSecret(a)).toThrow(/ENCRYPTION_PREVIOUS_KEYS/);
    } finally {
      useKeys(KEY_A, PREVIOUS);
    }
  });

  it('decrypts v1 values, which name no key, with any configured key', () => {
    const legacy = v1('legacy', KEY_A);
    expect(secretKeyId(legacy)).toBeNull();
    expect(decryptSecret(legacy)).toBe('legacy');
    try {
      useKeys(KEY_B, KEY_A);
      expect(decryptSecret(legacy)).toBe('legacy');
      useKeys(KEY_B);
      expect(() => decryptSecret(legacy)).toThrow(/ENCRYPTION_PREVIOUS_KEYS/);
    } finally {
      useKeys(KEY_A, PREVIOUS);
    }
  });

  it('refuses a previous key that is not 32 bytes', () => {
    try {
      useKeys(KEY_A, `${KEY_B},c2hvcnQ=`);
      expect(() => encryptSecret('x')).toThrow(/32 bytes/);
    } finally {
      useKeys(KEY_A, PREVIOUS);
    }
  });
});

describe('secrets:reencrypt', () => {
  it('registers every encrypted column', () => {
    const registered = encryptedColumns().flatMap(({ model, attributes }) =>
      attributes.map((a) => `${model.name}.${a}`),
    );
    const named = Object.values(getSequelize().models).flatMap((model) =>
      Object.keys(model.getAttributes())
        .filter((a) => a.endsWith('Encrypted'))
        .map((a) => `${model.name}.${a}`),
    );
    expect(named.length).toBeGreaterThanOrEqual(4);
    expect(registered).toEqual(expect.arrayContaining([...named, 'LmsOfflineLicense.contentKey']));
  });

  it('moves stored secrets to the current key and keeps passing connection tests', async () => {
    const gateway = { enabled: false, isDefault: false, useForInstitutes: false, sandbox: true };
    await saveGateway('mock', { ...gateway, merchantId: 'rotation', secretKey: 'rotation-secret' }, null);
    expect((await testGatewayConfig('mock', {})).ok).toBe(true);
    await AiSetting.destroy({ where: { scope: 'global' } });
    await AiSetting.create({
      scope: 'global',
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'gpt-test',
      apiKeyEncrypted: v1('sk-rotation', KEY_A),
      updatedBy: null,
    });
    const gatewayRow = () => PlatformIntegration.findOne({ where: { kind: 'gateway', slot: 'mock' } });
    const aiKey = async () => (await AiSetting.findOne({ where: { scope: 'global' } }))!.apiKeyEncrypted!;
    const before = (await gatewayRow())!;
    const aiBefore = await aiKey();

    try {
      useKeys(KEY_B, KEY_A);
      const B = encryptionKeys().current.id;
      const column = (reports: Awaited<ReturnType<typeof reencryptStoredSecrets>>, name: string) =>
        reports.find((r) => `${r.table}.${r.column}` === name)!;

      const dry = await reencryptStoredSecrets({ dryRun: true });
      expect(column(dry, 'platform_integrations.secrets_encrypted').reencrypted).toBeGreaterThanOrEqual(1);
      expect(column(dry, 'ai_settings.api_key_encrypted').reencrypted).toBe(1);
      expect((await gatewayRow())!.secretsEncrypted).toBe(before.secretsEncrypted);

      const run = await reencryptStoredSecrets();
      expect(column(run, 'ai_settings.api_key_encrypted')).toMatchObject({ total: 1, reencrypted: 1 });
      const after = (await gatewayRow())!;
      expect(secretKeyId(after.secretsEncrypted!)).toBe(B);
      expect(decryptSecret(after.secretsEncrypted!)).toBe(decryptSecret(before.secretsEncrypted!));
      expect(secretKeyId(await aiKey())).toBe(B);
      expect(decryptSecret(await aiKey())).toBe('sk-rotation');
      expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());

      // The test result was re-keyed: a new test of the same connection records the same fingerprint.
      expect(after.testedFingerprint).not.toBe(before.testedFingerprint);
      await testGatewayConfig('mock', {});
      expect((await gatewayRow())!.testedFingerprint).toBe(after.testedFingerprint);

      // Nothing is left on the old key, so it can go.
      useKeys(KEY_B);
      expect(
        column(await reencryptStoredSecrets({ dryRun: true }), 'ai_settings.api_key_encrypted'),
      ).toMatchObject({ current: 1, reencrypted: 0, failedIds: [] });
    } finally {
      useKeys(KEY_A, KEY_B);
      await reencryptStoredSecrets();
      useKeys(KEY_A, PREVIOUS);
    }
    expect(secretKeyId((await gatewayRow())!.secretsEncrypted!)).toBe(encryptionKeys().current.id);
    expect((await gatewayRow())!.testedFingerprint).toBe(before.testedFingerprint);
    expect(decryptSecret(await aiKey())).toBe(decryptSecret(aiBefore));
  });
});
