import {
  MESSAGING_PROVIDER_KINDS,
  providerFieldsFor,
  type ExternalChannel,
  type MessagingProviderKind,
  type NotificationProviderDto,
  type ProviderVerifyResultDto,
} from '@erp/shared';
import { decryptSecret, encryptSecret, maskSecret, randomToken } from '../../infrastructure/crypto';
import {
  createMessagingProvider,
  getDefaultMessagingProvider,
  hasMessagingWebhook,
  messagingWebhook,
  type MessagingProvider,
} from '../../infrastructure/messaging';
import { getContext } from '../../shared/context';
import { BadRequest } from '../../shared/errors';
import {
  MESSAGING_DESTINATION_FIELDS,
  assertStoredSecretReusable,
  changedDestinationFields,
} from '../../shared/utilities/secret-reuse';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { NotificationProvider } from './models';

export const EXTERNAL_CHANNELS: ExternalChannel[] = ['push', 'sms', 'whatsapp', 'email'];
export const DEFAULT_RETRY = { maxAttempts: 3, baseDelaySeconds: 60 };

export const providerRepo = new TenantRepository(NotificationProvider, { entity: 'Provider' });

function readSecrets(row: NotificationProvider): Record<string, string> {
  return row.secretsEncrypted
    ? (JSON.parse(decryptSecret(row.secretsEncrypted)) as Record<string, string>)
    : {};
}

export function toProviderDto(
  channel: ExternalChannel,
  row: NotificationProvider | null,
): NotificationProviderDto {
  if (!row) {
    return {
      channel,
      provider: 'console',
      isActive: true,
      settings: {},
      secretHints: {},
      retryMaxAttempts: DEFAULT_RETRY.maxAttempts,
      retryBaseDelaySeconds: DEFAULT_RETRY.baseDelaySeconds,
      updatedAt: null,
    };
  }
  const secrets = readSecrets(row);
  return {
    channel,
    provider: row.provider as MessagingProviderKind,
    isActive: row.isActive,
    settings: row.settings ?? {},
    secretHints: Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, maskSecret(v)])),
    retryMaxAttempts: row.retryMaxAttempts,
    retryBaseDelaySeconds: row.retryBaseDelaySeconds,
    updatedAt: row.updatedAt.toISOString(),
    webhook: messagingWebhook(row.provider, row.webhookKey),
  };
}

export async function listProviders(): Promise<NotificationProviderDto[]> {
  const rows = await providerRepo.findAll();
  return EXTERNAL_CHANNELS.map((c) => toProviderDto(c, rows.find((r) => r.channel === c) ?? null));
}

export interface ProviderInput {
  provider: MessagingProviderKind;
  isActive: boolean;
  settings: Record<string, string>;
  retryMaxAttempts?: number;
  retryBaseDelaySeconds?: number;
}

/**
 * Saves a channel's provider. Blank secret fields keep the stored value (same provider and
 * destination only: 400 SECRET_REQUIRED when e.g. the SMTP host changes).
 */
export async function saveProvider(channel: ExternalChannel, input: ProviderInput) {
  const kind = MESSAGING_PROVIDER_KINDS[input.provider];
  if (!(kind.channels as readonly string[]).includes(channel))
    throw BadRequest(`${kind.label} does not support ${channel}`);

  const fields = providerFieldsFor(input.provider, channel);
  const existing = await providerRepo.findOne({ where: { channel } });
  const previousSecrets = existing && existing.provider === input.provider ? readSecrets(existing) : {};
  // Kept secrets only go to the server they were saved for (e.g. the SMTP host).
  assertStoredSecretReusable(
    fields.some((f) => f.secret && !(input.settings[f.key] ?? '').trim() && previousSecrets[f.key]),
    changedDestinationFields(
      existing?.settings ?? {},
      input.settings,
      MESSAGING_DESTINATION_FIELDS[input.provider] ?? [],
    ),
    'provider secrets',
  );
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const value = (input.settings[f.key] ?? '').trim();
    if (f.secret) {
      const v = value || previousSecrets[f.key] || '';
      if (v) secrets[f.key] = v;
      else if (f.required) missing.push(f.label);
    } else {
      if (value) settings[f.key] = value;
      else if (f.required) missing.push(f.label);
    }
  }
  if (missing.length) throw BadRequest(`Missing provider settings: ${missing.join(', ')}`);

  const values = {
    channel,
    provider: input.provider,
    isActive: input.isActive,
    settings,
    secretsEncrypted: Object.keys(secrets).length ? encryptSecret(JSON.stringify(secrets)) : null,
    // Kept across saves of the same vendor so the URL pasted into its dashboard stays valid; another
    // vendor gets a new key, so an old vendor's URL never authenticates the new vendor's webhook.
    webhookKey: hasMessagingWebhook(input.provider)
      ? ((existing?.provider === input.provider ? existing.webhookKey : null) ?? randomToken(24))
      : null,
    retryMaxAttempts: input.retryMaxAttempts ?? existing?.retryMaxAttempts ?? DEFAULT_RETRY.maxAttempts,
    retryBaseDelaySeconds:
      input.retryBaseDelaySeconds ?? existing?.retryBaseDelaySeconds ?? DEFAULT_RETRY.baseDelaySeconds,
    updatedBy: getContext().userId ?? null,
  };
  const row = existing ? await providerRepo.update(existing.id, values) : await providerRepo.create(values);
  return toProviderDto(channel, row);
}

export interface ResolvedProvider {
  provider: MessagingProvider;
  retryMaxAttempts: number;
  retryBaseDelaySeconds: number;
}

/**
 * Institute provider for the channel when configured and active; otherwise the platform default
 * (the super admin's global provider, else the built-in console provider).
 */
export async function resolveProvider(channel: ExternalChannel): Promise<ResolvedProvider> {
  const row = await providerRepo.findOne({ where: { channel, isActive: true } });
  if (!row) {
    return {
      provider: await getDefaultMessagingProvider(channel),
      retryMaxAttempts: DEFAULT_RETRY.maxAttempts,
      retryBaseDelaySeconds: DEFAULT_RETRY.baseDelaySeconds,
    };
  }
  return {
    provider: buildProvider(row),
    retryMaxAttempts: row.retryMaxAttempts,
    retryBaseDelaySeconds: row.retryBaseDelaySeconds,
  };
}

/** The adapter for a saved institute provider row. */
export function buildProvider(row: NotificationProvider): MessagingProvider {
  const webhook = messagingWebhook(row.provider, row.webhookKey);
  return createMessagingProvider(
    row.provider,
    row.channel,
    { ...(row.settings ?? {}), ...readSecrets(row) },
    { webhookUrl: webhook?.url },
  );
}

/** Decrypted settings of a saved provider (webhook signature checks). */
export const providerSettings = (row: NotificationProvider): Record<string, string> => ({
  ...(row.settings ?? {}),
  ...readSecrets(row),
});

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 480);

/** Checks the saved provider's keys with the vendor without messaging anyone. */
export async function verifyProvider(channel: ExternalChannel): Promise<ProviderVerifyResultDto> {
  const row = await providerRepo.findOne({ where: { channel } });
  if (!row || row.provider === 'console')
    return {
      ok: true,
      provider: 'console',
      message: 'The console provider only logs messages; it has no keys.',
    };
  try {
    const provider = buildProvider(row);
    const message = provider.verify ? await provider.verify() : 'This provider has no key check.';
    return { ok: true, provider: row.provider, message };
  } catch (err) {
    return { ok: false, provider: row.provider, message: errorText(err) };
  }
}
