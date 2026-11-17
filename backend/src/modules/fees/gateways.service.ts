import { Op } from 'sequelize';
import type { GatewayConfigDto, PaymentGatewayKey } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { decryptSecret, encryptSecret, maskSecret, randomToken } from '../../infrastructure/crypto';
import {
  createPaymentGateway,
  type GatewayCredentials,
  type PaymentGateway,
} from '../../infrastructure/payment-gateways';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest } from '../../shared/errors';
import { requireTenantContext } from '../../shared/context';
import { PaymentGatewayConfig } from './models';

export const gatewayRepo = new TenantRepository(PaymentGatewayConfig, { entity: 'Payment gateway' });

export function webhookUrl(c: PaymentGatewayConfig) {
  return `${config.API_PUBLIC_URL}/api/fees/public/webhooks/${c.gateway}/${c.webhookKey}`;
}

export function gatewayDto(c: PaymentGatewayConfig): GatewayConfigDto {
  return {
    id: c.id,
    gateway: c.gateway,
    enabled: c.enabled,
    isDefault: c.isDefault,
    merchantId: c.merchantId,
    keyHint: c.keyHint,
    sandbox: c.sandbox,
    webhookUrl: webhookUrl(c),
  };
}

export interface GatewayConfigInput {
  gateway: PaymentGatewayKey;
  enabled?: boolean;
  isDefault?: boolean;
  merchantId?: string | null;
  /** Merchant secret / key secret. Omit to keep the stored one. */
  secretKey?: string;
  /** Webhook signing secret (defaults to the secret key). */
  webhookSecret?: string;
  extra?: Record<string, string>;
  sandbox?: boolean;
}

interface StoredSecrets {
  secretKey?: string;
  webhookSecret?: string;
  extra?: Record<string, string>;
}

export async function upsertGatewayConfig(input: GatewayConfigInput) {
  const { instituteId } = requireTenantContext();
  const existing = await gatewayRepo.findOne({ where: { gateway: input.gateway } });
  const prev: StoredSecrets = existing?.secretEncrypted
    ? JSON.parse(decryptSecret(existing.secretEncrypted))
    : {};
  const secrets: StoredSecrets = {
    secretKey: input.secretKey ?? prev.secretKey,
    webhookSecret: input.webhookSecret ?? prev.webhookSecret,
    extra: input.extra ?? prev.extra,
  };
  if (input.gateway !== 'mock' && (input.enabled ?? existing?.enabled ?? true) && !secrets.secretKey)
    throw BadRequest('Merchant secret key is required to enable this gateway');
  const values = {
    enabled: input.enabled ?? existing?.enabled ?? true,
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    merchantId: input.merchantId !== undefined ? input.merchantId : (existing?.merchantId ?? null),
    secretEncrypted:
      secrets.secretKey || secrets.webhookSecret ? encryptSecret(JSON.stringify(secrets)) : null,
    keyHint: secrets.secretKey ? maskSecret(secrets.secretKey) : null,
    sandbox: input.sandbox ?? existing?.sandbox ?? true,
  };
  const before = existing ? gatewayDto(existing) : null;
  const row = existing
    ? await existing.update(values)
    : await gatewayRepo.create({ gateway: input.gateway, webhookKey: randomToken(24), ...values });
  if (row.isDefault)
    await PaymentGatewayConfig.update(
      { isDefault: false },
      { where: { instituteId, isDefault: true, id: { [Op.ne]: row.id } } },
    );
  return { before, row };
}

export function credentialsOf(c: PaymentGatewayConfig): GatewayCredentials {
  const s: StoredSecrets = c.secretEncrypted ? JSON.parse(decryptSecret(c.secretEncrypted)) : {};
  return {
    merchantId: c.merchantId ?? undefined,
    secretKey: s.secretKey,
    webhookSecret: s.webhookSecret,
    extra: s.extra,
    sandbox: c.sandbox,
  };
}

export function adapterFor(c: PaymentGatewayConfig): PaymentGateway {
  return createPaymentGateway(c.gateway, credentialsOf(c));
}

export async function enabledGateways(): Promise<PaymentGatewayConfig[]> {
  const rows = await gatewayRepo.findAll({
    where: { enabled: true },
    order: [
      ['isDefault', 'DESC'],
      ['id', 'ASC'],
    ],
  });
  return rows;
}

/** Picks the requested (or default) enabled gateway for checkout. */
export async function resolveGateway(name?: PaymentGatewayKey): Promise<PaymentGatewayConfig> {
  const rows = await enabledGateways();
  const row = name ? rows.find((r) => r.gateway === name) : rows[0];
  if (!row) throw BadRequest('Online payments are not configured for this institute');
  return row;
}
