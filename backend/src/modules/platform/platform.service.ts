import {
  MESSAGING_PROVIDER_KINDS,
  PROVIDER_FIELDS,
  providerFieldsFor,
  type ExternalChannel,
  type IntegrationTestResultDto,
  type IntegrationTestStatus,
  type MessagingProviderKind,
  type PlatformGatewayDto,
  type PlatformGatewayInput,
  type PlatformIntegrationsDto,
  type PlatformMessagingDto,
  type PlatformMessagingInput,
  type PlatformStorageDto,
  type PlatformStorageInput,
  type StorageDriverKey,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import {
  decryptSecret,
  encryptSecret,
  hmac,
  maskSecret,
  randomToken,
  safeEqual,
} from '../../infrastructure/crypto';
import { logger } from '../../infrastructure/logger';
import {
  createMessagingProvider,
  hasMessagingWebhook,
  messagingWebhook,
  otpSms,
  type MessagingProvider,
  type OutboundMessage,
  type WebhookProviderMatch,
} from '../../infrastructure/messaging';
import {
  createPaymentGateway,
  PAYMENT_GATEWAY_NAMES,
  type GatewayCredentials,
  type PaymentGatewayName,
} from '../../infrastructure/payment-gateways';
import {
  createStorageAdapter,
  getStorage,
  setStorage,
  type S3Connection,
  type StorageAdapter,
} from '../../infrastructure/storage';
import type { InferCreationAttributes } from 'sequelize';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import {
  MESSAGING_DESTINATION_FIELDS,
  assertStoredSecretReusable,
  changedDestinationFields,
} from '../../shared/utilities/secret-reuse';
import { PlatformIntegration, type IntegrationKind } from './models';

export const MESSAGING_CHANNELS = [
  'sms',
  'whatsapp',
  'email',
  'push',
] as const satisfies readonly ExternalChannel[];
const STORAGE_SLOT = 'default';

type Secrets = Record<string, string>;
interface Entry {
  row: PlatformIntegration;
  secrets: Secrets;
}
interface TestOutcome {
  ok: boolean;
  message: string;
}

// ------------------------------------------------------------------ snapshot cache

/**
 * Integrations are read on hot paths (OTP sends, checkouts, notification delivery) and by sync
 * consumers (fee gateway credentials), so all rows are cached as one snapshot. Saves refresh it
 * immediately; other processes (worker, other API instances) pick changes up within the TTL.
 */
const SNAPSHOT_TTL_MS = 30_000;
let snapshot = new Map<string, Entry>();
let loadedAt = 0;
let loadSeq = 0;
let appliedSeq = 0;
let inflight: Promise<void> | null = null;

const keyOf = (kind: IntegrationKind, slot: string) => `${kind}:${slot}`;

function readSecrets(row: PlatformIntegration): Secrets {
  if (!row.secretsEncrypted) return {};
  try {
    return JSON.parse(decryptSecret(row.secretsEncrypted)) as Secrets;
  } catch (err) {
    logger.error({ err, kind: row.kind, slot: row.slot }, 'Cannot decrypt platform integration secrets');
    return {};
  }
}

async function reload(): Promise<void> {
  const seq = ++loadSeq;
  const rows = await PlatformIntegration.findAll({ order: [['id', 'ASC']] });
  if (seq < appliedSeq) return; // a newer load already applied
  appliedSeq = seq;
  snapshot = new Map(rows.map((row) => [keyOf(row.kind, row.slot), { row, secrets: readSecrets(row) }]));
  loadedAt = Date.now();
  applyStorage();
}

/** Loads the snapshot when stale (or always with `force`). */
export async function loadIntegrations(force = false): Promise<void> {
  if (!force && loadedAt && Date.now() - loadedAt < SNAPSHOT_TTL_MS) return;
  if (!force && inflight) return inflight;
  const run = reload();
  inflight = run;
  try {
    await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

/** Forgets the snapshot (tests editing rows directly). */
export function invalidatePlatformIntegrations(): void {
  loadedAt = 0;
}

/** Sync read for consumers that cannot await; schedules a refresh when stale. */
function cachedEntry(kind: IntegrationKind, slot: string): Entry | undefined {
  if (!loadedAt || Date.now() - loadedAt >= SNAPSHOT_TTL_MS)
    void loadIntegrations().catch((err) => logger.error({ err }, 'Platform integrations refresh failed'));
  return snapshot.get(keyOf(kind, slot));
}

async function entry(kind: IntegrationKind, slot: string): Promise<Entry | undefined> {
  await loadIntegrations();
  return snapshot.get(keyOf(kind, slot));
}

function entries(kind: IntegrationKind): Entry[] {
  return [...snapshot.values()].filter((e) => e.row.kind === kind);
}

// ------------------------------------------------------------------ shared save/test plumbing

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** Identifies a connection configuration (provider, endpoints, credentials; not on/off flags). */
const fingerprint = (connection: { secrets?: Secrets } & Record<string, unknown>) =>
  hmac(stableJson({ ...connection, secrets: present(connection.secrets ?? {}) }), config.ENCRYPTION_KEY);

/** Drops blank secrets (they are not stored). */
const present = (secrets: Secrets): Secrets =>
  Object.fromEntries(Object.entries(secrets).filter(([, v]) => !!v));

const errorMessage = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 480) || 'Unknown error';

const UNTESTED = { testedFingerprint: null, lastTestOk: null, lastTestedAt: null, lastTestMessage: null };

/**
 * Test-gated activation: an integration can be enabled only once its current connection
 * configuration passed a connection test. Changing the connection resets the test result; enabling
 * an untested configuration runs the test inline and saves nothing when it fails.
 */
async function testFieldsForSave(
  existing: PlatformIntegration | undefined,
  enabled: boolean,
  print: string,
  runTest: (() => Promise<TestOutcome>) | null,
) {
  const sameConnection = existing?.testedFingerprint === print;
  if (enabled && !(sameConnection && existing?.lastTestOk)) {
    if (!runTest)
      throw Conflict(
        'Run a successful connection test before enabling this integration',
        'INTEGRATION_TEST_REQUIRED',
      );
    const outcome = await runTest();
    if (!outcome.ok)
      throw Conflict(`Connection test failed: ${outcome.message}`, 'INTEGRATION_TEST_FAILED', {
        message: outcome.message,
      });
    return {
      testedFingerprint: print,
      lastTestOk: true,
      lastTestedAt: new Date(),
      lastTestMessage: outcome.message,
    };
  }
  return sameConnection ? {} : UNTESTED;
}

/** Records a test result when it ran against the saved connection configuration. */
async function recordTest(row: PlatformIntegration | undefined, print: string, outcome: TestOutcome) {
  const testedAt = new Date();
  if (row && rowFingerprint(row) === print) {
    await row.update({
      testedFingerprint: print,
      lastTestOk: outcome.ok,
      lastTestedAt: testedAt,
      lastTestMessage: outcome.message.slice(0, 500),
    });
    await loadIntegrations(true);
  }
  return { ok: outcome.ok, message: outcome.message, testedAt: testedAt.toISOString() };
}

type RowValues = Partial<
  Omit<InferCreationAttributes<PlatformIntegration>, 'id' | 'kind' | 'slot' | 'createdAt' | 'updatedAt'>
> & { provider: string };

async function upsertRow(kind: IntegrationKind, slot: string, values: RowValues) {
  const existing = await PlatformIntegration.findOne({ where: { kind, slot } });
  if (existing) await existing.update(values);
  else
    await PlatformIntegration.create({
      kind,
      slot,
      secretsEncrypted: null,
      updatedBy: null,
      ...UNTESTED,
      ...values,
    });
  await loadIntegrations(true);
}

const encryptSecrets = (secrets: Secrets) => {
  const stored = present(secrets);
  return Object.keys(stored).length ? encryptSecret(JSON.stringify(stored)) : null;
};

const testStatus = (row: PlatformIntegration | undefined): IntegrationTestStatus => ({
  lastTestedAt: row?.lastTestedAt ? new Date(row.lastTestedAt).toISOString() : null,
  lastTestOk: row?.lastTestOk ?? null,
  lastTestMessage: row?.lastTestMessage ?? null,
});

/** Fingerprint of a saved row's connection configuration. */
function rowFingerprint(row: PlatformIntegration): string {
  const secrets = readSecrets(row);
  if (row.kind === 'gateway') return gatewayFingerprint(row.slot, gatewaySettings(row), secrets);
  if (row.kind === 'messaging')
    return fingerprint({ provider: row.provider, fields: messagingFields(row), secrets });
  return storageFingerprint(row.provider as StorageDriverKey, storageSettings(row), secrets);
}

// ------------------------------------------------------------------ payment gateways

interface GatewaySettings {
  isDefault: boolean;
  useForInstitutes: boolean;
  sandbox: boolean;
  merchantId: string | null;
  /** Paytm's website name (WEBSTAGING / DEFAULT unless Paytm assigned another). */
  website: string | null;
}

function gatewaySettings(row: PlatformIntegration | undefined): GatewaySettings {
  const s = (row?.settings ?? {}) as Partial<GatewaySettings>;
  return {
    isDefault: !!s.isDefault,
    useForInstitutes: !!s.useForInstitutes,
    sandbox: s.sandbox ?? true,
    merchantId: s.merchantId ?? null,
    website: s.website ?? null,
  };
}

const gatewayFingerprint = (gateway: string, s: GatewaySettings, secrets: Secrets) =>
  fingerprint({
    provider: gateway,
    sandbox: s.sandbox,
    merchantId: s.merchantId,
    ...(s.website ? { website: s.website } : {}),
    secrets,
  });

/** The mock gateway accepts forged payments by design: never usable in production. */
const usableGateway = (gateway: string) => !(gateway === 'mock' && config.isProd);

export function assertGatewayName(name: string): PaymentGatewayName {
  if (!(PAYMENT_GATEWAY_NAMES as readonly string[]).includes(name)) throw NotFound('Payment gateway');
  return name as PaymentGatewayName;
}

const saasWebhookUrl = (gateway: string) =>
  `${config.API_PUBLIC_URL}/api/subscriptions/public/webhooks/${gateway}`;

function gatewayDto(gateway: PaymentGatewayName): PlatformGatewayDto {
  const e = snapshot.get(keyOf('gateway', gateway));
  const s = gatewaySettings(e?.row);
  const secretKey = e?.secrets.secretKey;
  return {
    gateway,
    enabled: e?.row.enabled ?? false,
    isDefault: s.isDefault,
    useForInstitutes: s.useForInstitutes,
    sandbox: s.sandbox,
    merchantId: s.merchantId,
    website: s.website,
    hasSecret: !!secretKey,
    keyHint: secretKey ? maskSecret(secretKey) : null,
    hasWebhookSecret: !!e?.secrets.webhookSecret,
    webhookUrl: saasWebhookUrl(gateway),
    updatedAt: e ? new Date(e.row.updatedAt).toISOString() : null,
    ...testStatus(e?.row),
  };
}

function gatewayCredentials(s: GatewaySettings, secrets: Secrets): GatewayCredentials {
  return {
    merchantId: s.merchantId ?? undefined,
    secretKey: secrets.secretKey || undefined,
    webhookSecret: secrets.webhookSecret || undefined,
    ...(s.website ? { extra: { website: s.website } } : {}),
    sandbox: s.sandbox,
  };
}

const entryCredentials = (e: Entry) => gatewayCredentials(gatewaySettings(e.row), e.secrets);

async function testGateway(gateway: PaymentGatewayName, creds: GatewayCredentials): Promise<TestOutcome> {
  if (!usableGateway(gateway)) return { ok: false, message: 'The mock gateway cannot be used in production' };
  try {
    return await createPaymentGateway(gateway, creds).testConnection();
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Merges a gateway form over the saved configuration (blank secrets keep the stored ones). */
function mergeGateway(gateway: PaymentGatewayName, input: Partial<PlatformGatewayInput>) {
  const e = snapshot.get(keyOf('gateway', gateway));
  const saved = gatewaySettings(e?.row);
  const settings: GatewaySettings = {
    isDefault: input.isDefault ?? saved.isDefault,
    useForInstitutes: input.useForInstitutes ?? saved.useForInstitutes,
    sandbox: input.sandbox ?? saved.sandbox,
    merchantId: input.merchantId === undefined ? saved.merchantId : input.merchantId?.trim() || null,
    website: input.website === undefined ? saved.website : input.website?.trim() || null,
  };
  // Sandbox and live are different gateway endpoints: switching needs the secret key again.
  assertStoredSecretReusable(
    !input.secretKey?.trim() && !!e?.secrets.secretKey,
    changedDestinationFields(saved, settings, ['sandbox']),
    'secret key',
  );
  const secrets: Secrets = {
    secretKey: input.secretKey?.trim() || e?.secrets.secretKey || '',
    webhookSecret: input.webhookSecret?.trim() || e?.secrets.webhookSecret || '',
  };
  return { existing: e?.row, settings, secrets };
}

export async function saveGateway(
  gateway: PaymentGatewayName,
  input: PlatformGatewayInput,
  userId: number | null,
): Promise<PlatformGatewayDto> {
  await loadIntegrations(true);
  const { existing, settings, secrets } = mergeGateway(gateway, input);
  if (input.enabled && !usableGateway(gateway))
    throw BadRequest('The mock gateway cannot be enabled in production');
  if (input.enabled && gateway !== 'mock' && !secrets.secretKey)
    throw BadRequest('A secret key is required to enable this gateway');
  const print = gatewayFingerprint(gateway, settings, secrets);
  const tests = await testFieldsForSave(existing, input.enabled, print, () =>
    testGateway(gateway, gatewayCredentials(settings, secrets)),
  );
  if (settings.isDefault)
    for (const other of entries('gateway'))
      if (other.row.slot !== gateway && gatewaySettings(other.row).isDefault)
        await other.row.update({ settings: { ...gatewaySettings(other.row), isDefault: false } });
  await upsertRow('gateway', gateway, {
    provider: gateway,
    enabled: input.enabled,
    settings: { ...settings },
    secretsEncrypted: encryptSecrets(secrets),
    updatedBy: userId,
    ...tests,
  });
  return gatewayDto(gateway);
}

export async function testGatewayConfig(
  gateway: PaymentGatewayName,
  input: Partial<PlatformGatewayInput>,
): Promise<IntegrationTestResultDto> {
  await loadIntegrations(true);
  const { existing, settings, secrets } = mergeGateway(gateway, input);
  const outcome = await testGateway(gateway, gatewayCredentials(settings, secrets));
  return recordTest(existing, gatewayFingerprint(gateway, settings, secrets), outcome);
}

export async function removeGateway(gateway: PaymentGatewayName): Promise<boolean> {
  const removed = await PlatformIntegration.destroy({ where: { kind: 'gateway', slot: gateway } });
  await loadIntegrations(true);
  return removed > 0;
}

/**
 * SaaS subscription payments. `checkout` returns the requested (or default) enabled gateway;
 * `verify` returns a configured gateway even when it was disabled after the order was created.
 */
export async function resolveSaasGateway(input: { gateway?: string; purpose: 'checkout' | 'verify' }) {
  await loadIntegrations();
  const usable = entries('gateway').filter((e) => usableGateway(e.row.slot));
  let pick: Entry | undefined;
  if (input.purpose === 'verify') pick = usable.find((e) => e.row.slot === input.gateway);
  else {
    const enabled = usable.filter((e) => e.row.enabled);
    pick = input.gateway
      ? enabled.find((e) => e.row.slot === input.gateway)
      : (enabled.find((e) => gatewaySettings(e.row).isDefault) ?? enabled[0]);
  }
  return pick ? { gateway: pick.row.slot as PaymentGatewayName, credentials: entryCredentials(pick) } : null;
}

/** Gateway offered to institutes without an enabled fee gateway of their own. */
export async function offeredInstituteGateway() {
  await loadIntegrations();
  const offered = entries('gateway').filter(
    (e) => e.row.enabled && usableGateway(e.row.slot) && gatewaySettings(e.row).useForInstitutes,
  );
  const pick = offered.find((e) => gatewaySettings(e.row).isDefault) ?? offered[0];
  return pick
    ? { gateway: pick.row.slot as PaymentGatewayName, sandbox: gatewaySettings(pick.row).sandbox }
    : null;
}

/** Platform credentials for institute fee payments taken through the platform gateway. */
export function instituteGatewayCredentials(gateway: string): GatewayCredentials | null {
  const e = cachedEntry('gateway', gateway);
  return e && usableGateway(gateway) ? entryCredentials(e) : null;
}

// ------------------------------------------------------------------ notification providers

export function assertChannel(name: string): ExternalChannel {
  if (!(MESSAGING_CHANNELS as readonly string[]).includes(name)) throw NotFound('Notification channel');
  return name as ExternalChannel;
}

/**
 * The webhook key of vendors with delivery webhooks is kept next to the provider fields; it is
 * neither a connection field (fingerprint) nor shown as a setting.
 */
const WEBHOOK_KEY = 'webhookKey';

function messagingFields(row: PlatformIntegration | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries((row?.settings ?? {}) as Record<string, string>).filter(([k]) => k !== WEBHOOK_KEY),
  );
}

const messagingWebhookKey = (row: PlatformIntegration | undefined): string | null =>
  ((row?.settings ?? {}) as Record<string, string>)[WEBHOOK_KEY] || null;

function messagingDto(channel: ExternalChannel): PlatformMessagingDto {
  const e = snapshot.get(keyOf('messaging', channel));
  const provider = (e?.row.provider ?? 'console') as MessagingProviderKind;
  const secretHints: Record<string, string> = {};
  for (const f of PROVIDER_FIELDS[provider] ?? [])
    if (f.secret && e?.secrets[f.key]) secretHints[f.key] = maskSecret(e.secrets[f.key]);
  return {
    channel,
    provider,
    enabled: e?.row.enabled ?? false,
    settings: messagingFields(e?.row),
    secretHints,
    configured: !!e,
    updatedAt: e ? new Date(e.row.updatedAt).toISOString() : null,
    webhook: messagingWebhook(provider, messagingWebhookKey(e?.row)),
    ...testStatus(e?.row),
  };
}

/** Validates provider fields like institute providers do; blank secrets keep the stored ones. */
function mergeMessaging(
  channel: ExternalChannel,
  input: Pick<PlatformMessagingInput, 'provider' | 'settings'>,
) {
  const kind = MESSAGING_PROVIDER_KINDS[input.provider as MessagingProviderKind];
  if (!kind) throw BadRequest(`Unknown provider: ${input.provider}`);
  if (!(kind.channels as readonly string[]).includes(channel))
    throw BadRequest(`${kind.label} does not support ${channel}`);
  const e = snapshot.get(keyOf('messaging', channel));
  const previous = e && e.row.provider === input.provider ? e.secrets : {};
  const providerFields = providerFieldsFor(input.provider as MessagingProviderKind, channel, {
    platform: true,
  });
  assertStoredSecretReusable(
    providerFields.some((f) => f.secret && !(input.settings[f.key] ?? '').trim() && previous[f.key]),
    changedDestinationFields(
      e?.row.settings ?? {},
      input.settings,
      MESSAGING_DESTINATION_FIELDS[input.provider] ?? [],
    ),
    'provider secrets',
  );
  const fields: Record<string, string> = {};
  const secrets: Secrets = {};
  const missing: string[] = [];
  for (const f of providerFields) {
    const value = (input.settings[f.key] ?? '').trim();
    if (f.secret) {
      const v = value || previous[f.key] || '';
      if (v) secrets[f.key] = v;
      else if (f.required) missing.push(f.label);
    } else if (value) fields[f.key] = value;
    else if (f.required) missing.push(f.label);
  }
  if (missing.length) throw BadRequest(`Missing provider settings: ${missing.join(', ')}`);
  return {
    existing: e?.row,
    fields,
    secrets,
    print: fingerprint({ provider: input.provider, fields, secrets }),
  };
}

export interface MessagingTestOptions {
  /** Vendor template to send (WhatsApp: an approved template such as `hello_world:en_US`). */
  templateId?: string;
  body?: string;
}

/**
 * SMS tests send the login OTP message (DLT / OTP template of the settings), so a passing test
 * means OTP login works; other channels send a plain message or the given vendor template.
 */
function testMessage(channel: ExternalChannel, to: string, options: MessagingTestOptions): OutboundMessage {
  if (channel === 'sms' && !options.templateId && !options.body)
    return { ...otpSms(to, '123456', config.OTP_TTL_SECONDS), data: { purpose: 'connection-test' } };
  return {
    to,
    subject: 'Test message',
    body: options.body || `Test message: the platform's default ${channel} provider is working.`,
    ...(options.templateId ? { templateId: options.templateId, variables: [] } : {}),
    data: { purpose: 'connection-test' },
  };
}

async function testMessaging(
  channel: ExternalChannel,
  provider: string,
  connection: Record<string, string>,
  to: string,
  options: MessagingTestOptions = {},
): Promise<TestOutcome> {
  try {
    const result = await createMessagingProvider(provider, channel, connection).send(
      testMessage(channel, to, options),
    );
    if (result.status === 'failed') return { ok: false, message: result.error || 'Delivery failed' };
    return { ok: true, message: `Test message ${result.status} to ${to}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Key check: asks the vendor to accept the credentials without messaging anyone. */
async function verifyMessaging(
  channel: ExternalChannel,
  provider: string,
  connection: Record<string, string>,
): Promise<TestOutcome> {
  if (provider === 'console')
    return { ok: true, message: 'The console provider only logs messages; it has no keys.' };
  try {
    const adapter = createMessagingProvider(provider, channel, connection);
    return { ok: true, message: adapter.verify ? await adapter.verify() : 'This provider has no key check.' };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function saveMessaging(
  channel: ExternalChannel,
  input: PlatformMessagingInput,
  userId: number | null,
): Promise<PlatformMessagingDto> {
  await loadIntegrations(true);
  const { existing, fields, secrets, print } = mergeMessaging(channel, input);
  const to = input.testTo?.trim();
  const tests = await testFieldsForSave(
    existing,
    input.enabled,
    print,
    to ? () => testMessaging(channel, input.provider, { ...fields, ...secrets }, to) : null,
  );
  // Kept across saves of the same vendor so the URL pasted into its dashboard stays valid.
  const webhookKey = hasMessagingWebhook(input.provider)
    ? ((existing?.provider === input.provider ? messagingWebhookKey(existing) : null) ?? randomToken(24))
    : null;
  await upsertRow('messaging', channel, {
    provider: input.provider,
    enabled: input.enabled,
    settings: webhookKey ? { ...fields, [WEBHOOK_KEY]: webhookKey } : fields,
    secretsEncrypted: encryptSecrets(secrets),
    updatedBy: userId,
    ...tests,
  });
  return messagingDto(channel);
}

/** The form's (or else the saved) connection of a channel, validated like a save. */
async function messagingConnection(
  channel: ExternalChannel,
  input: Partial<Pick<PlatformMessagingInput, 'provider' | 'settings'>>,
) {
  await loadIntegrations(true);
  const saved = snapshot.get(keyOf('messaging', channel));
  const provider = input.provider ?? saved?.row.provider;
  if (!provider) throw BadRequest('Choose a provider to test');
  const savedFields = saved && saved.row.provider === provider ? messagingFields(saved.row) : {};
  return {
    provider,
    ...mergeMessaging(channel, { provider, settings: { ...savedFields, ...(input.settings ?? {}) } }),
  };
}

export async function testMessagingConfig(
  channel: ExternalChannel,
  input: Partial<Pick<PlatformMessagingInput, 'provider' | 'settings'>>,
  to: string,
  options: MessagingTestOptions = {},
): Promise<IntegrationTestResultDto> {
  const { provider, existing, fields, secrets, print } = await messagingConnection(channel, input);
  const outcome = await testMessaging(channel, provider, { ...fields, ...secrets }, to, options);
  return recordTest(existing, print, outcome);
}

/** Key check of the form's (or saved) credentials; a pass counts as the connection test. */
export async function verifyMessagingConfig(
  channel: ExternalChannel,
  input: Partial<Pick<PlatformMessagingInput, 'provider' | 'settings'>>,
): Promise<IntegrationTestResultDto> {
  const { provider, existing, fields, secrets, print } = await messagingConnection(channel, input);
  const outcome = await verifyMessaging(channel, provider, { ...fields, ...secrets });
  return recordTest(existing, print, outcome);
}

export async function removeMessaging(channel: ExternalChannel): Promise<boolean> {
  const removed = await PlatformIntegration.destroy({ where: { kind: 'messaging', slot: channel } });
  await loadIntegrations(true);
  return removed > 0;
}

/** The super admin's enabled provider for a channel (institute providers take precedence). */
export async function defaultMessagingProvider(channel: ExternalChannel): Promise<MessagingProvider | null> {
  const e = await entry('messaging', channel);
  if (!e?.row.enabled) return null;
  return createMessagingProvider(
    e.row.provider,
    channel,
    { ...messagingFields(e.row), ...e.secrets },
    { webhookUrl: messagingWebhook(e.row.provider, messagingWebhookKey(e.row))?.url },
  );
}

/** The platform provider whose delivery webhook carries this key (disabled ones too: late reports). */
export async function platformMessagingWebhook(
  vendor: string,
  webhookKey: string,
): Promise<WebhookProviderMatch | null> {
  await loadIntegrations();
  for (const e of entries('messaging')) {
    const key = messagingWebhookKey(e.row);
    if (e.row.provider === vendor && key && safeEqual(key, webhookKey))
      return {
        channel: e.row.slot as ExternalChannel,
        kind: e.row.provider,
        settings: { ...messagingFields(e.row), ...e.secrets },
      };
  }
  return null;
}

// ------------------------------------------------------------------ storage

interface StorageSettings {
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  accessKeyId: string | null;
}

function storageSettings(row: PlatformIntegration | undefined): StorageSettings {
  const s = (row?.settings ?? {}) as Partial<StorageSettings>;
  return {
    bucket: s.bucket ?? null,
    region: s.region ?? null,
    endpoint: s.endpoint ?? null,
    accessKeyId: s.accessKeyId ?? null,
  };
}

const storageFingerprint = (driver: StorageDriverKey, s: StorageSettings, secrets: Secrets) =>
  fingerprint(driver === 'local' ? { provider: 'local' } : { provider: driver, ...s, secrets });

function storageConnection(s: StorageSettings, secrets: Secrets): S3Connection {
  return {
    bucket: s.bucket ?? undefined,
    region: s.region ?? undefined,
    endpoint: s.endpoint ?? undefined,
    accessKeyId: s.accessKeyId ?? undefined,
    secretAccessKey: secrets.secretAccessKey || undefined,
  };
}

/** Signature of the adapter the platform applied; null = the environment default is in use. */
let appliedStorage: string | null = null;

/** Applies the active storage configuration to this process (runs on every snapshot load). */
function applyStorage(): void {
  const e = snapshot.get(keyOf('storage', STORAGE_SLOT));
  const active = e?.row.enabled ? e : null;
  const signature = active ? rowFingerprint(active.row) : null;
  if (signature === appliedStorage) return;
  setStorage(
    active
      ? createStorageAdapter(
          active.row.provider as StorageDriverKey,
          storageConnection(storageSettings(active.row), active.secrets),
        )
      : null,
  );
  appliedStorage = signature;
  logger.info({ driver: getStorage().driver }, 'File storage driver applied');
}

function storageDto(): PlatformStorageDto {
  const e = snapshot.get(keyOf('storage', STORAGE_SLOT));
  const s = storageSettings(e?.row);
  const secret = e?.secrets.secretAccessKey;
  return {
    driver: (e?.row.provider as StorageDriverKey | undefined) ?? config.STORAGE_DRIVER,
    active: e?.row.enabled ?? false,
    ...s,
    hasSecret: !!secret,
    secretHint: secret ? maskSecret(secret) : null,
    effectiveDriver: getStorage().driver,
    envDriver: config.STORAGE_DRIVER,
    updatedAt: e ? new Date(e.row.updatedAt).toISOString() : null,
    ...testStatus(e?.row),
  };
}

function mergeStorage(input: Partial<PlatformStorageInput>) {
  const e = snapshot.get(keyOf('storage', STORAGE_SLOT));
  const saved = storageSettings(e?.row);
  const driver = input.driver ?? (e?.row.provider as StorageDriverKey | undefined) ?? config.STORAGE_DRIVER;
  const pick = (v: string | null | undefined, fallback: string | null) =>
    v === undefined ? fallback : v?.trim() || null;
  // Local disk takes its root from the server environment: there is nothing else to store.
  const settings: StorageSettings =
    driver === 'local'
      ? { bucket: null, region: null, endpoint: null, accessKeyId: null }
      : {
          bucket: pick(input.bucket, saved.bucket),
          region: pick(input.region, saved.region),
          endpoint: pick(input.endpoint, saved.endpoint),
          accessKeyId: pick(input.accessKeyId, saved.accessKeyId),
        };
  // The stored secret only goes to the driver, endpoint and bucket it was saved for.
  if (driver !== 'local')
    assertStoredSecretReusable(
      !input.secretAccessKey?.trim() && !!e?.secrets.secretAccessKey,
      changedDestinationFields({ ...saved, driver: e?.row.provider }, { ...settings, driver }, [
        'driver',
        'endpoint',
        'bucket',
      ]),
      'secret access key',
    );
  const secrets: Secrets =
    driver === 'local'
      ? {}
      : { secretAccessKey: input.secretAccessKey?.trim() || e?.secrets.secretAccessKey || '' };
  return { existing: e?.row, driver, settings, secrets };
}

async function testStorage(adapter: StorageAdapter): Promise<TestOutcome> {
  const key = `platform/storage-test/${randomToken(12)}.txt`;
  const data = Buffer.from(`Storage connection test ${new Date().toISOString()}`);
  try {
    await adapter.putBuffer(key, data, 'text/plain');
    const stat = await adapter.stat(key);
    if (stat?.size !== data.length) throw new Error('The uploaded test file could not be read back');
    await adapter.delete(key);
    return { ok: true, message: 'Upload, read-back and delete succeeded' };
  } catch (err) {
    await Promise.resolve()
      .then(() => adapter.delete(key))
      .catch(() => undefined);
    return { ok: false, message: errorMessage(err) };
  }
}

export async function saveStorage(
  input: PlatformStorageInput,
  userId: number | null,
): Promise<PlatformStorageDto> {
  await loadIntegrations(true);
  const { existing, driver, settings, secrets } = mergeStorage(input);
  if (
    input.active &&
    driver !== 'local' &&
    !(settings.bucket && settings.accessKeyId && secrets.secretAccessKey)
  )
    throw BadRequest('Bucket, access key id and secret access key are required to activate this driver');
  const print = storageFingerprint(driver, settings, secrets);
  const tests = await testFieldsForSave(existing, input.active, print, () =>
    testStorage(createStorageAdapter(driver, storageConnection(settings, secrets))),
  );
  await upsertRow('storage', STORAGE_SLOT, {
    provider: driver,
    enabled: input.active,
    settings: { ...settings },
    secretsEncrypted: encryptSecrets(secrets),
    updatedBy: userId,
    ...tests,
  });
  return storageDto();
}

export async function testStorageConfig(
  input: Partial<PlatformStorageInput>,
): Promise<IntegrationTestResultDto> {
  await loadIntegrations(true);
  const { existing, driver, settings, secrets } = mergeStorage(input);
  const outcome = await testStorage(createStorageAdapter(driver, storageConnection(settings, secrets)));
  return recordTest(existing, storageFingerprint(driver, settings, secrets), outcome);
}

// ------------------------------------------------------------------ listing

export async function integrationsDto(): Promise<PlatformIntegrationsDto> {
  await loadIntegrations(true);
  return {
    gateways: PAYMENT_GATEWAY_NAMES.map(gatewayDto),
    messaging: MESSAGING_CHANNELS.map(messagingDto),
    storage: storageDto(),
  };
}

export { gatewayDto, messagingDto, storageDto };
