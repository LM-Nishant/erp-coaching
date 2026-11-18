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

/**
 * Super admin fallback, registered by the platform module: the global gateway offered to institutes
 * that have no enabled gateway of their own. Institute configuration always takes precedence.
 */
export interface PlatformFeesGatewayProvider {
  /** Gateway currently offered to institutes, or null. */
  offered(): Promise<{ gateway: PaymentGatewayKey; sandbox: boolean } | null>;
  /** The platform's current credentials for a gateway, or null once it is removed. */
  credentials(gateway: PaymentGatewayKey): GatewayCredentials | null;
}

let platformGateway: PlatformFeesGatewayProvider | null = null;

export function setPlatformFeesGatewayProvider(provider: PlatformFeesGatewayProvider | null): void {
  platformGateway = provider;
}

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
    platformManaged: c.platformManaged,
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
    // Saving makes it the institute's own configuration (no longer the platform fallback).
    platformManaged: false,
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
  if (c.platformManaged) return platformGateway?.credentials(c.gateway) ?? { sandbox: c.sandbox };
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

/**
 * Enabled gateways, default first. Without an enabled gateway of its own the institute gets the
 * platform's offered gateway, provisioned on first use as a platform-managed config.
 */
export async function enabledGateways(): Promise<PaymentGatewayConfig[]> {
  const rows = await gatewayRepo.findAll({
    where: { enabled: true },
    order: [
      ['isDefault', 'DESC'],
      ['id', 'ASC'],
    ],
  });
  const own = rows.filter((r) => !r.platformManaged);
  if (own.length || !platformGateway) return own;
  const offered = await platformGateway.offered();
  if (!offered) return [];
  const managed = rows.find((r) => r.gateway === offered.gateway);
  if (managed) return [managed];
  const provisioned = await provisionPlatformGateway(offered);
  return provisioned ? [provisioned] : [];
}

async function provisionPlatformGateway(offered: { gateway: PaymentGatewayKey; sandbox: boolean }) {
  // The institute's own (disabled) configuration of this gateway takes precedence: no fallback.
  const existing = await gatewayRepo.findOne({ where: { gateway: offered.gateway } });
  if (existing) return existing.platformManaged && existing.enabled ? existing : null;
  try {
    return await gatewayRepo.create({
      gateway: offered.gateway,
      enabled: true,
      isDefault: false,
      merchantId: null,
      secretEncrypted: null,
      keyHint: null,
      sandbox: offered.sandbox,
      webhookKey: randomToken(24),
      platformManaged: true,
    });
  } catch (err) {
    if ((err as { name?: string }).name !== 'SequelizeUniqueConstraintError') throw err;
    return gatewayRepo.findOne({ where: { gateway: offered.gateway, enabled: true, platformManaged: true } });
  }
}

/** Picks the requested (or default) enabled gateway for checkout. */
export async function resolveGateway(name?: PaymentGatewayKey): Promise<PaymentGatewayConfig> {
  const rows = await enabledGateways();
  let row = name ? rows.find((r) => r.gateway === name) : rows[0];
  // Payments taken through the platform fallback stay serviceable (status sync, refunds) after the
  // institute configures its own gateway, while the platform still has the gateway.
  if (!row && name && platformGateway?.credentials(name))
    row =
      (await gatewayRepo.findOne({ where: { gateway: name, enabled: true, platformManaged: true } })) ??
      undefined;
  if (!row) throw BadRequest('Online payments are not configured for this institute');
  return row;
}
