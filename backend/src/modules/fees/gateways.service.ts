import { Op } from 'sequelize';
import type { GatewayConfigDto, PaymentGatewayKey } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { decryptSecret, encryptSecret, maskSecret, randomToken } from '../../infrastructure/crypto';
import { logger } from '../../infrastructure/logger';
import {
  GATEWAY_LABELS,
  GatewayConfigError,
  GatewayRequestError,
  createPaymentGateway,
  type ConnectionTestResult,
  type GatewayCredentials,
  type PaymentGateway,
} from '../../infrastructure/payment-gateways';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest } from '../../shared/errors';
import { requireTenantContext } from '../../shared/context';
import { assertStoredSecretReusable, changedDestinationFields } from '../../shared/utilities/secret-reuse';
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

/** The mock gateway completes payments on request: development and tests only, never production. */
export const mockGatewayAllowed = () => !config.isProd;

export function webhookUrl(c: PaymentGatewayConfig) {
  return `${config.API_PUBLIC_URL}/api/fees/public/webhooks/${c.gateway}/${c.webhookKey}`;
}

interface StoredSecrets {
  secretKey?: string;
  webhookSecret?: string;
  extra?: Record<string, string>;
}

function storedSecrets(c: PaymentGatewayConfig): StoredSecrets {
  return c.secretEncrypted ? (JSON.parse(decryptSecret(c.secretEncrypted)) as StoredSecrets) : {};
}

export function gatewayDto(c: PaymentGatewayConfig): GatewayConfigDto {
  let secrets: StoredSecrets = {};
  try {
    secrets = storedSecrets(c);
  } catch (err) {
    logger.warn({ gatewayConfigId: c.id, err }, 'Stored payment gateway secrets could not be read');
  }
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
    hasSecret: !!secrets.secretKey,
    hasWebhookSecret: !!secrets.webhookSecret,
    website: secrets.extra?.website ?? null,
  };
}

export interface GatewayConfigInput {
  gateway: PaymentGatewayKey;
  enabled?: boolean;
  isDefault?: boolean;
  /** Paytm MID, Razorpay key ID or Cashfree client ID. */
  merchantId?: string | null;
  /** Paytm merchant key, Razorpay key secret or Cashfree client secret. Blank keeps the stored one. */
  secretKey?: string;
  /** Razorpay webhook secret (Paytm and Cashfree sign webhooks with the key). Blank keeps the stored one. */
  webhookSecret?: string;
  /** Paytm website name; blank uses WEBSTAGING (staging) or DEFAULT (production). */
  website?: string | null;
  extra?: Record<string, string>;
  sandbox?: boolean;
}

const MERCHANT_ID_LABELS: Record<PaymentGatewayKey, string> = {
  mock: 'Merchant ID',
  paytm: 'Merchant ID (MID)',
  razorpay: 'Key ID',
  cashfree: 'Client ID (app ID)',
};
const SECRET_LABELS: Record<PaymentGatewayKey, string> = {
  mock: 'secret key',
  paytm: 'merchant key',
  razorpay: 'key secret',
  cashfree: 'client secret',
};

export async function upsertGatewayConfig(input: GatewayConfigInput) {
  const { instituteId } = requireTenantContext();
  const existing = await gatewayRepo.findOne({ where: { gateway: input.gateway } });
  // A platform-managed row holds no institute keys: saving starts the institute's own configuration.
  const own = existing && !existing.platformManaged ? existing : null;
  const prev: StoredSecrets = own ? storedSecrets(own) : {};
  const secretKey = input.secretKey?.trim() || undefined;
  const extra = { ...(input.extra ?? prev.extra ?? {}) };
  if (input.website !== undefined) {
    const website = input.website?.trim();
    if (website) extra.website = website;
    else delete extra.website;
  }
  const secrets: StoredSecrets = {
    secretKey: secretKey ?? prev.secretKey,
    webhookSecret: input.webhookSecret?.trim() || prev.webhookSecret,
    extra: Object.keys(extra).length ? extra : undefined,
  };
  const sandbox = input.sandbox ?? existing?.sandbox ?? true;
  // Test and live modes are different vendor environments: switching needs the key again.
  if (own && input.gateway !== 'mock')
    assertStoredSecretReusable(
      !secretKey && !!prev.secretKey,
      changedDestinationFields({ sandbox: own.sandbox }, { sandbox }, ['sandbox']),
      SECRET_LABELS[input.gateway],
    );
  const merchantId =
    input.merchantId !== undefined ? input.merchantId?.trim() || null : (own?.merchantId ?? null);
  const enabled = input.enabled ?? existing?.enabled ?? true;
  if (input.gateway === 'mock' && enabled && !mockGatewayAllowed())
    throw BadRequest('The mock gateway cannot be used in production');
  if (input.gateway !== 'mock' && enabled) {
    if (!merchantId)
      throw BadRequest(`The ${MERCHANT_ID_LABELS[input.gateway]} is required to enable this gateway`);
    if (!secrets.secretKey)
      throw BadRequest(`The ${SECRET_LABELS[input.gateway]} is required to enable this gateway`);
  }
  const values = {
    enabled,
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    merchantId,
    secretEncrypted:
      secrets.secretKey || secrets.webhookSecret || secrets.extra
        ? encryptSecret(JSON.stringify(secrets))
        : null,
    keyHint: secrets.secretKey ? maskSecret(secrets.secretKey) : null,
    sandbox,
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
  const s = storedSecrets(c);
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
  const rows = (
    await gatewayRepo.findAll({
      where: { enabled: true },
      order: [
        ['isDefault', 'DESC'],
        ['id', 'ASC'],
      ],
    })
  ).filter((r) => r.gateway !== 'mock' || mockGatewayAllowed());
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

/**
 * The institute's configuration of `name`, enabled or not: payments already taken with a gateway
 * stay serviceable (status checks, refunds, reconciliation) after it is switched off.
 */
export async function gatewayConfigFor(name: PaymentGatewayKey): Promise<PaymentGatewayConfig> {
  const row = await gatewayRepo.findOne({ where: { gateway: name } });
  if (!row) throw BadRequest(`${GATEWAY_LABELS[name]} is not configured for this institute`);
  return row;
}

/** Checks the saved keys with a read-only vendor call; nothing is charged. */
export async function testGatewayConnection(name: PaymentGatewayKey): Promise<ConnectionTestResult> {
  const row = await gatewayConfigFor(name);
  if (row.platformManaged)
    throw BadRequest('This gateway is provided by the platform: there are no keys to test');
  try {
    return await adapterFor(row).testConnection();
  } catch (err) {
    if (err instanceof GatewayConfigError || err instanceof GatewayRequestError)
      return { ok: false, message: err.message };
    throw err;
  }
}
