import type { BillingPolicyDto, BillingProfileDto } from '@erp/shared';
import { SubscriptionSetting } from './models';

export const DEFAULT_BILLING_PROFILE: BillingProfileDto = {
  legalName: 'Coaching ERP Cloud',
  gstin: null,
  address: null,
  city: null,
  state: null,
  pincode: null,
  email: null,
  phone: null,
  invoicePrefix: 'SAAS',
  creditNotePrefix: 'SCN',
  sacCode: '998315',
  gstRatePercent: 18,
};

export const DEFAULT_BILLING_POLICY: BillingPolicyDto = {
  graceDays: 7,
  trialGraceDays: 3,
  afterGrace: 'restricted',
  suspendAfterDays: 30,
  renewalLeadDays: 7,
  invoiceDueDays: 7,
};

const PROFILE_KEY = 'billing.profile';
const POLICY_KEY = 'billing.policy';
/** Settings are read on every tenant request (access state): cache briefly per process. */
const TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; at: number }>();

async function read<T extends object>(key: string, defaults: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const row = await SubscriptionSetting.findOne({ where: { key } });
  const value = { ...defaults, ...((row?.value as Partial<T> | undefined) ?? {}) };
  cache.set(key, { value, at: Date.now() });
  return value;
}

async function write<T extends object>(
  key: string,
  defaults: T,
  patch: Partial<T>,
  userId: number | null,
): Promise<T> {
  const value = { ...(await read(key, defaults)), ...patch };
  const [row, created] = await SubscriptionSetting.findOrCreate({
    where: { key },
    defaults: { key, value, updatedBy: userId },
  });
  if (!created) await row.update({ value, updatedBy: userId });
  cache.delete(key);
  return value;
}

export const getBillingProfile = () => read(PROFILE_KEY, DEFAULT_BILLING_PROFILE);
export const getBillingPolicy = () => read(POLICY_KEY, DEFAULT_BILLING_POLICY);

export const saveBillingProfile = (patch: Partial<BillingProfileDto>, userId: number | null) =>
  write(PROFILE_KEY, DEFAULT_BILLING_PROFILE, patch, userId);
export const saveBillingPolicy = (patch: Partial<BillingPolicyDto>, userId: number | null) =>
  write(POLICY_KEY, DEFAULT_BILLING_POLICY, patch, userId);

/** Drops cached settings (tests that write the table directly). */
export function clearBillingSettingsCache(): void {
  cache.clear();
}
