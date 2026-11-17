import {
  MESSAGING_PROVIDER_KINDS,
  PROVIDER_FIELDS,
  type ExternalChannel,
  type MessagingProviderKind,
  type NotificationProviderDto,
} from '@erp/shared';
import { decryptSecret, encryptSecret, maskSecret } from '../../infrastructure/crypto';
import {
  createMessagingProvider,
  getMessagingProvider,
  type MessagingProvider,
} from '../../infrastructure/messaging';
import { getContext } from '../../shared/context';
import { BadRequest } from '../../shared/errors';
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

/** Saves a channel's provider. Blank secret fields keep the stored value (same provider only). */
export async function saveProvider(channel: ExternalChannel, input: ProviderInput) {
  const kind = MESSAGING_PROVIDER_KINDS[input.provider];
  if (!(kind.channels as readonly string[]).includes(channel))
    throw BadRequest(`${kind.label} does not support ${channel}`);

  const existing = await providerRepo.findOne({ where: { channel } });
  const previousSecrets = existing && existing.provider === input.provider ? readSecrets(existing) : {};
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of PROVIDER_FIELDS[input.provider]) {
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

/** Institute provider for the channel when configured and active; otherwise the platform default. */
export async function resolveProvider(channel: ExternalChannel): Promise<ResolvedProvider> {
  const row = await providerRepo.findOne({ where: { channel, isActive: true } });
  if (!row) {
    return {
      provider: getMessagingProvider(channel),
      retryMaxAttempts: DEFAULT_RETRY.maxAttempts,
      retryBaseDelaySeconds: DEFAULT_RETRY.baseDelaySeconds,
    };
  }
  return {
    provider: createMessagingProvider(row.provider, channel, {
      ...(row.settings ?? {}),
      ...readSecrets(row),
    }),
    retryMaxAttempts: row.retryMaxAttempts,
    retryBaseDelaySeconds: row.retryBaseDelaySeconds,
  };
}
