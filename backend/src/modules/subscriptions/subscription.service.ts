import { Op, type Transaction } from 'sequelize';
import {
  ADDON_LIMIT_KEY,
  METERED_METRICS,
  METRIC_LIMIT_KEY,
  type BillingPolicyDto,
  type PlanLimits,
  type SubscriptionAccessState,
  type SubscriptionStatus,
} from '@erp/shared';
import { Plan, Subscription, SubscriptionAddon } from './models';
import { AppError, LimitExceeded } from '../../shared/errors';
import { getBillingPolicy } from './billing-settings';
import { DAY_MS, monthKey } from './util';

export const UNLIMITED: PlanLimits = {
  maxStudents: null,
  maxBranches: null,
  maxTeachers: null,
  storageMb: null,
  aiTokensMonthly: null,
  enabledModules: null,
};

/** Statuses of a subscription that is still the institute's current one (even if lapsed). */
export const CURRENT_STATUSES: SubscriptionStatus[] = ['trial', 'active', 'past_due', 'expired'];

/**
 * The institute's current subscription: the latest started, non-cancelled row. It may have lapsed;
 * `getAccessState` tells whether the institute still has full, read-only or no access.
 */
export async function getCurrentSubscription(
  instituteId: number,
  opts: { transaction?: Transaction; lock?: boolean } = {},
) {
  const sub = await Subscription.findOne({
    where: { instituteId, status: { [Op.in]: CURRENT_STATUSES }, startsAt: { [Op.lte]: new Date() } },
    order: [
      ['startsAt', 'DESC'],
      ['id', 'DESC'],
    ],
    transaction: opts.transaction,
    lock: opts.lock && opts.transaction ? opts.transaction.LOCK.UPDATE : undefined,
  });
  if (!sub) return null;
  const [plan, pendingPlan] = await Promise.all([
    Plan.findByPk(sub.planId, { transaction: opts.transaction }),
    sub.pendingPlanId ? Plan.findByPk(sub.pendingPlanId, { transaction: opts.transaction }) : null,
  ]);
  if (plan) sub.plan = plan;
  sub.pendingPlan = pendingPlan;
  return sub;
}

/** Kept for existing callers: the current subscription (see `getCurrentSubscription`). */
export const getActiveSubscription = (instituteId: number) => getCurrentSubscription(instituteId);

export interface AccessInfo {
  state: SubscriptionAccessState;
  subscription: Subscription | null;
  /** End of the grace period after `endsAt`. */
  graceEndsAt: Date | null;
  /** When access becomes suspended (null = never). */
  suspendsAt: Date | null;
}

/**
 * Access timeline of a subscription with an end date:
 * `endsAt` → grace (full access) → `afterGrace` (read-only `restricted`, or `suspended`) →
 * suspended after `suspendAfterDays`. A manual suspension wins; open-ended subscriptions never lapse.
 */
export function computeAccessState(
  sub: Subscription | null,
  policy: BillingPolicyDto,
  now = new Date(),
): AccessInfo {
  if (!sub) return { state: 'none', subscription: null, graceEndsAt: null, suspendsAt: null };
  const trial = sub.status === 'trial';
  let graceEndsAt: Date | null = null;
  let suspendsAt: Date | null = null;
  if (sub.endsAt) {
    graceEndsAt = new Date(
      sub.endsAt.getTime() + (trial ? policy.trialGraceDays : policy.graceDays) * DAY_MS,
    );
    if (policy.afterGrace === 'suspended') suspendsAt = graceEndsAt;
    else if (policy.suspendAfterDays !== null)
      suspendsAt = new Date(graceEndsAt.getTime() + policy.suspendAfterDays * DAY_MS);
  }
  const info = (state: SubscriptionAccessState): AccessInfo => ({
    state,
    subscription: sub,
    graceEndsAt,
    suspendsAt,
  });
  if (sub.suspendedAt) return info('suspended');
  if (!sub.endsAt || sub.endsAt > now) return info(trial ? 'trial' : 'active');
  if (graceEndsAt && now < graceEndsAt) return info('grace');
  if (suspendsAt && now >= suspendsAt) return info('suspended');
  return info('restricted');
}

export async function getAccessState(instituteId: number, now = new Date()): Promise<AccessInfo> {
  const [sub, policy] = await Promise.all([getCurrentSubscription(instituteId), getBillingPolicy()]);
  return computeAccessState(sub, policy, now);
}

/**
 * The request guard reads the access state on every tenant request: the current subscription row
 * is cached briefly per process (the state itself is recomputed from it on each call). Lifecycle
 * changes and payments call `invalidateAccess`; plan limits are never cached.
 */
const ACCESS_TTL_MS = 10_000;
const accessCache = new Map<number, { sub: Subscription | null; at: number }>();

export async function getAccessStateCached(instituteId: number, now = new Date()): Promise<AccessInfo> {
  let hit = accessCache.get(instituteId);
  if (!hit || Date.now() - hit.at >= ACCESS_TTL_MS) {
    hit = { sub: await getCurrentSubscription(instituteId), at: Date.now() };
    accessCache.set(instituteId, hit);
  }
  return computeAccessState(hit.sub, await getBillingPolicy(), now);
}

/** Drops the cached subscription of one institute (or all, e.g. in tests after direct DB edits). */
export function invalidateAccess(instituteId?: number): void {
  if (instituteId === undefined) accessCache.clear();
  else accessCache.delete(instituteId);
}

/** Adds an active add-on to included limits (`ai_credits` only count in their month). */
export function applyAddon(limits: PlanLimits, addon: SubscriptionAddon, now = new Date()): void {
  if (addon.kind === 'module') {
    if (limits.enabledModules && addon.moduleKey && !limits.enabledModules.includes(addon.moduleKey))
      limits.enabledModules = [...limits.enabledModules, addon.moduleKey];
    return;
  }
  if (addon.kind === 'ai_credits' && addon.periodMonth !== monthKey(now)) return;
  const key = ADDON_LIMIT_KEY[addon.kind];
  const current = limits[key];
  if (current !== null && current !== undefined) limits[key] = current + addon.unitSize * addon.quantity;
}

/**
 * Included limits: plan limits with the super admin's absolute overrides, plus active add-ons.
 * null = unlimited.
 */
export async function includedLimitsFor(
  sub: Subscription,
  plan: Plan,
  now = new Date(),
  transaction?: Transaction,
): Promise<PlanLimits> {
  const limits: PlanLimits = { ...UNLIMITED, ...plan.limits, ...(sub.limitOverrides ?? {}) };
  const addons = await SubscriptionAddon.findAll({
    where: { instituteId: sub.instituteId, status: 'active' },
    transaction,
  });
  for (const a of addons) applyAddon(limits, a, now);
  return limits;
}

/** Enforced limits: metrics with overage pricing may exceed the included limit up to `maxOverage`. */
export function enforcedLimits(included: PlanLimits, plan: Plan): PlanLimits {
  const out = { ...included };
  for (const metric of METERED_METRICS) {
    const price = plan.usagePricing?.[metric];
    const key = METRIC_LIMIT_KEY[metric];
    const inc = out[key];
    if (!price || inc === null || inc === undefined) continue;
    out[key] = price.maxOverage === null || price.maxOverage === undefined ? null : inc + price.maxOverage;
  }
  return out;
}

/**
 * Effective (enforced) limits: plan + overrides + add-ons + overage allowance.
 * Throws 402 SUBSCRIPTION_INACTIVE when the institute has no subscription.
 */
export async function getPlanLimits(instituteId: number): Promise<PlanLimits> {
  const sub = await getCurrentSubscription(instituteId);
  if (!sub?.plan)
    throw new AppError(402, 'SUBSCRIPTION_INACTIVE', 'The institute has no active subscription');
  return enforcedLimits(await includedLimitsFor(sub, sub.plan), sub.plan);
}

type NumericLimit = 'maxStudents' | 'maxBranches' | 'maxTeachers' | 'storageMb' | 'aiTokensMonthly';

/** Throws PLAN_LIMIT_EXCEEDED when `current + adding` would exceed the plan limit. */
export async function assertWithinLimit(
  instituteId: number,
  limit: NumericLimit,
  current: number,
  adding = 1,
) {
  const limits = await getPlanLimits(instituteId);
  const max = limits[limit];
  if (max !== null && max !== undefined && current + adding > max) {
    throw LimitExceeded(`Plan limit reached for ${limit} (${max})`, { limit, max, current });
  }
}

export async function isModuleEnabled(instituteId: number, moduleName: string): Promise<boolean> {
  const limits = await getPlanLimits(instituteId);
  return limits.enabledModules === null || limits.enabledModules.includes(moduleName);
}
