import { Op, type Transaction } from 'sequelize';
import {
  ADDON_LABELS,
  METRIC_LABELS,
  METRIC_LIMIT_KEY,
  type AddonKind,
  type BillingActionResultDto,
  type BillingCycle,
  type BillingOverviewDto,
  type MeteredMetric,
  type PlanAddonPrice,
  type PlanChangePreviewDto,
  type PlanDto,
  type PlanLimits,
  type SubscriptionAddonDto,
  type SubscriptionDto,
  type SubscriptionStatusDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import { audit } from '../../shared/audit/audit.service';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { Plan, Subscription, SubscriptionAddon, SubscriptionInvoice, type InvoiceMeta } from './models';
import { getBillingPolicy, getBillingProfile } from './billing-settings';
import {
  CURRENT_STATUSES,
  UNLIMITED,
  applyAddon,
  computeAccessState,
  enforcedLimits,
  getCurrentSubscription,
  includedLimitsFor,
  invalidateAccess,
  type AccessInfo,
} from './subscription.service';
import { aiQuota, currentUsage, usageMetrics } from './usage.service';
import { createInvoice, toInvoiceDto, voidInvoice, type InvoiceLineInput } from './invoices.service';
import { DAY_MS, addCycle, addDays, billingDate, formatDay, formatRupees, monthKey } from './util';

const MANAGED_MESSAGE = 'Your plan is managed by the platform team. Contact support to change it.';

// ------------------------------------------------------------------ pricing

export const isRecurringAddon = (kind: AddonKind) => kind !== 'ai_credits';

export const priceFor = (plan: Plan, cycle: BillingCycle) =>
  cycle === 'yearly' ? plan.priceYearlyPaise : plan.priceMonthlyPaise;

/** A plan is not sold on a cycle priced at 0 while the other cycle has a price. */
export function assertCycleOffered(plan: Plan, cycle: BillingCycle): void {
  const other: BillingCycle = cycle === 'yearly' ? 'monthly' : 'yearly';
  if (priceFor(plan, cycle) === 0 && priceFor(plan, other) > 0)
    throw BadRequest(`${plan.name} is not offered with ${cycle} billing`);
}

export function catalogueEntry(
  plan: Plan,
  kind: AddonKind,
  moduleKey?: string | null,
): PlanAddonPrice | undefined {
  return (plan.addons ?? []).find((a) => a.kind === kind && (kind !== 'module' || a.moduleKey === moduleKey));
}

/** Price of one pack per billing cycle (AI credits: per pack, one-time). */
export function addonPrice(entry: PlanAddonPrice, cycle: BillingCycle): number {
  if (entry.kind === 'ai_credits' || cycle === 'monthly') return entry.monthlyPricePaise;
  return entry.yearlyPricePaise || entry.monthlyPricePaise * 12;
}

const moduleIncluded = (plan: Plan, moduleKey: string | null) =>
  plan.limits.enabledModules === null || (!!moduleKey && plan.limits.enabledModules.includes(moduleKey));

/** Unused share of the current paid period, in [0, 1]. */
export function remainingFraction(sub: Subscription, now: Date): number {
  if (!sub.endsAt) return 0;
  const start = (sub.currentPeriodStart ?? sub.startsAt).getTime();
  const end = sub.endsAt.getTime();
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (end - now.getTime()) / (end - start)));
}

export function addonLabel(a: { kind: AddonKind; moduleKey: string | null; unitSize: number }): string {
  if (a.kind === 'module') return `Module: ${a.moduleKey ?? ''}`;
  return `${ADDON_LABELS[a.kind]}, ${a.unitSize.toLocaleString('en-IN')} per pack`;
}

const MONTH_FORMAT = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const monthLabel = (d: Date) => MONTH_FORMAT.format(d);

// ------------------------------------------------------------------ DTOs

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const planRef = (p: Plan | null | undefined) => (p ? { id: p.id, code: p.code, name: p.name } : null);

export function toPlanDto(p: Plan, activeSubscriptions?: number): PlanDto {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    priceMonthlyPaise: p.priceMonthlyPaise,
    priceYearlyPaise: p.priceYearlyPaise,
    trialDays: p.trialDays,
    limits: p.limits,
    addons: p.addons ?? [],
    usagePricing: p.usagePricing ?? {},
    isActive: p.isActive,
    ...(activeSubscriptions !== undefined ? { activeSubscriptions } : {}),
  };
}

export function toSubscriptionDto(s: Subscription): SubscriptionDto {
  return {
    id: s.id,
    instituteId: s.instituteId,
    planId: s.planId,
    plan: planRef(s.plan),
    status: s.status,
    billingCycle: s.billingCycle,
    startsAt: s.startsAt.toISOString(),
    endsAt: iso(s.endsAt),
    currentPeriodStart: iso(s.currentPeriodStart ?? s.startsAt),
    pendingPlanId: s.pendingPlanId ?? null,
    pendingPlan: planRef(s.pendingPlan),
    pendingBillingCycle: s.pendingBillingCycle ?? null,
    suspendedAt: iso(s.suspendedAt),
    suspendReason: s.suspendReason ?? null,
    trialExtendedDays: s.trialExtendedDays ?? 0,
    limitOverrides: s.limitOverrides,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toAddonDto(a: SubscriptionAddon): SubscriptionAddonDto {
  return {
    id: a.id,
    kind: a.kind,
    moduleKey: a.moduleKey,
    quantity: a.quantity,
    unitSize: a.unitSize,
    unitPricePaise: a.unitPricePaise,
    billingCycle: a.billingCycle,
    status: a.status,
    cancelAtPeriodEnd: a.cancelAtPeriodEnd,
    startsAt: iso(a.startsAt),
    periodMonth: a.periodMonth,
    invoiceId: a.invoiceId,
    createdAt: a.createdAt.toISOString(),
  };
}

const daysUntil = (d: Date | null, now: Date) =>
  d ? Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY_MS)) : null;

export function toStatusDto(
  access: AccessInfo,
  canManage: boolean,
  renewalLeadDays: number,
  now = new Date(),
): SubscriptionStatusDto {
  const sub = access.subscription;
  const planName = sub?.plan?.name ?? null;
  const endsAt = sub?.endsAt ?? null;
  let daysLeft: number | null = null;
  let message: string | null = null;
  switch (access.state) {
    case 'none':
      message = 'There is no active subscription. Contact the platform team.';
      break;
    case 'trial':
      daysLeft = daysUntil(endsAt, now);
      if (endsAt) message = `Your free trial of ${planName} ends on ${formatDay(endsAt)}.`;
      break;
    case 'active':
      daysLeft = daysUntil(endsAt, now);
      if (endsAt && daysLeft !== null && daysLeft <= renewalLeadDays)
        message = `Your ${planName} subscription is due for renewal on ${formatDay(endsAt)}.`;
      break;
    case 'grace':
      daysLeft = daysUntil(access.graceEndsAt, now);
      message = `Your subscription ended on ${formatDay(endsAt!)}. Renew before ${formatDay(
        access.graceEndsAt!,
      )} to avoid interruption.`;
      break;
    case 'restricted':
      daysLeft = daysUntil(access.suspendsAt, now);
      message =
        'Your subscription has expired: the app is read-only until it is renewed.' +
        (access.suspendsAt ? ` Access will be suspended on ${formatDay(access.suspendsAt)}.` : '');
      break;
    case 'suspended':
      message = sub?.suspendedAt
        ? `Your account is suspended${sub.suspendReason ? `: ${sub.suspendReason}` : ''}. Contact support.`
        : 'Your account is suspended for non-payment. Pay the outstanding invoice to restore access.';
      break;
  }
  return {
    state: access.state,
    planName,
    endsAt: iso(endsAt),
    graceEndsAt: iso(access.graceEndsAt),
    suspendsAt: iso(access.suspendsAt),
    daysLeft,
    canManage,
    message,
  };
}

// ------------------------------------------------------------------ shared helpers

async function requireSubscription(instituteId: number, transaction: Transaction) {
  const sub = await getCurrentSubscription(instituteId, { transaction, lock: true });
  if (!sub?.plan) throw Conflict('The institute has no subscription', 'NO_SUBSCRIPTION');
  return sub;
}

async function loadTargetPlan(planId: number, transaction?: Transaction): Promise<Plan> {
  const plan = await Plan.findByPk(planId, { transaction });
  if (!plan || !plan.isActive) throw NotFound('Plan');
  return plan;
}

const withTransaction = <T>(fn: (t: Transaction) => Promise<T>) => getSequelize().transaction(fn);

/** Open invoices of the subscription that apply a lifecycle action when paid. */
async function openActionInvoices(
  sub: Subscription,
  action: InvoiceMeta['action'],
  transaction: Transaction,
) {
  const open = await SubscriptionInvoice.findAll({
    where: { instituteId: sub.instituteId, subscriptionId: sub.id, status: 'open' },
    order: [['id', 'ASC']],
    transaction,
  });
  return open.filter((i) => i.meta?.action === action);
}

const untouched = (inv: SubscriptionInvoice) => inv.paidPaise === 0 && inv.creditedPaise === 0;

async function voidSuperseded(invoices: SubscriptionInvoice[], reason: string, transaction: Transaction) {
  for (const inv of invoices) if (untouched(inv)) await voidInvoice(inv.id, reason, transaction);
}

/** Recurring add-ons that continue on `plan` (offered by it, not cancelled, not now included). */
async function carriedAddons(sub: Subscription, plan: Plan, transaction?: Transaction) {
  const addons = await SubscriptionAddon.findAll({
    where: { instituteId: sub.instituteId, status: 'active' },
    order: [['id', 'ASC']],
    transaction,
  });
  return addons.flatMap((addon) => {
    if (!isRecurringAddon(addon.kind) || addon.cancelAtPeriodEnd) return [];
    if (addon.kind === 'module' && moduleIncluded(plan, addon.moduleKey)) return [];
    const entry = catalogueEntry(plan, addon.kind, addon.moduleKey);
    return entry ? [{ addon, entry }] : [];
  });
}

/** Included limits the institute would have on `plan` (overrides and carried add-ons kept). */
async function limitsOnPlan(sub: Subscription, plan: Plan, now: Date, transaction?: Transaction) {
  const limits: PlanLimits = { ...UNLIMITED, ...plan.limits, ...(sub.limitOverrides ?? {}) };
  const carried = new Set((await carriedAddons(sub, plan, transaction)).map((c) => c.addon.id));
  const active = await SubscriptionAddon.findAll({
    where: { instituteId: sub.instituteId, status: 'active' },
    transaction,
  });
  for (const a of active) if (!isRecurringAddon(a.kind) || carried.has(a.id)) applyAddon(limits, a, now);
  return enforcedLimits(limits, plan);
}

const SEAT_METRICS: MeteredMetric[] = ['students', 'branches', 'teachers', 'storageMb'];

/** Metrics whose current usage exceeds the limits of `plan` (a change to it is refused). */
async function usageBlockers(sub: Subscription, plan: Plan, now: Date, transaction?: Transaction) {
  const [limits, usage] = await Promise.all([
    limitsOnPlan(sub, plan, now, transaction),
    currentUsage(sub.instituteId, now),
  ]);
  return SEAT_METRICS.flatMap((metric) => {
    const limit = limits[METRIC_LIMIT_KEY[metric]];
    const used = usage[metric];
    return limit !== null && limit !== undefined && used > limit ? [{ metric, used, limit }] : [];
  });
}

// ------------------------------------------------------------------ renewal

/**
 * Start of the next paid term: a trial converts when it ends; a subscription renewed before the
 * end of its grace period continues back-to-back from `termStart`, a longer-lapsed one from now.
 */
async function nextTermStart(sub: Subscription, termStart: Date, now: Date): Promise<Date> {
  if (sub.status === 'trial') return new Date(Math.max(now.getTime(), sub.endsAt?.getTime() ?? 0));
  const start = sub.endsAt && sub.endsAt > termStart ? sub.endsAt : termStart;
  if (start >= now) return start;
  const { graceEndsAt } = computeAccessState(sub, await getBillingPolicy(), now);
  return graceEndsAt && now < graceEndsAt ? start : now;
}

/**
 * Issues the invoice for the next term: the pending (downgrade) plan or the current one, plus the
 * recurring add-ons that continue. A trial converts from the end of the trial. A free renewal is
 * applied at once (returns null).
 */
async function issueRenewal(
  sub: Subscription,
  transaction: Transaction,
  now: Date,
  createdBy: number | null = null,
): Promise<SubscriptionInvoice | null> {
  const target = sub.pendingPlan ?? sub.plan!;
  const cycle = sub.pendingBillingCycle ?? sub.billingCycle;
  const trial = sub.status === 'trial';
  const periodStart = await nextTermStart(sub, sub.endsAt ?? now, now);
  const periodEnd = addCycle(periodStart, cycle);
  const addons = trial ? [] : await carriedAddons(sub, target, transaction);
  const lines: InvoiceLineInput[] = [];
  const planPrice = priceFor(target, cycle);
  if (planPrice > 0)
    lines.push({
      description: `${target.name} plan (${cycle}), ${formatDay(periodStart)} to ${formatDay(periodEnd)}`,
      unitPricePaise: planPrice,
      itemType: 'plan',
    });
  for (const { addon, entry } of addons) {
    const unit = addonPrice(entry, cycle);
    if (unit > 0)
      lines.push({
        description: addonLabel(addon),
        quantity: addon.quantity,
        unitPricePaise: unit,
        itemType: `addon:${addon.kind}`,
      });
  }
  const meta: InvoiceMeta = {
    action: 'renew',
    planId: target.id,
    billingCycle: cycle,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    addonIds: addons.map((a) => a.addon.id),
  };
  if (!lines.length) {
    await applyRenewal(sub, meta, transaction, now);
    return null;
  }
  return createInvoice(
    {
      instituteId: sub.instituteId,
      subscriptionId: sub.id,
      kind: trial ? 'subscription' : 'renewal',
      lines,
      periodStart,
      periodEnd,
      dueDate: periodStart > now ? billingDate(periodStart) : undefined,
      meta,
      createdBy,
      now,
    },
    transaction,
  );
}

/** Re-issues an open, unpaid renewal invoice after the plan, cycle, trial end or add-ons changed. */
async function refreshOpenRenewal(sub: Subscription, transaction: Transaction, now: Date) {
  const open = await openActionInvoices(sub, 'renew', transaction);
  if (!open.length || !open.every(untouched)) return null;
  await voidSuperseded(open, 'Replaced after a subscription change', transaction);
  return issueRenewal(sub, transaction, now);
}

/** Paid renewal: the next term starts at the end of the current one (or now, after the grace). */
async function applyRenewal(sub: Subscription, meta: InvoiceMeta, transaction: Transaction, now: Date) {
  const cycle = meta.billingCycle ?? sub.billingCycle;
  const planId = meta.planId ?? sub.planId;
  const start = await nextTermStart(
    sub,
    meta.periodStart ? new Date(meta.periodStart) : (sub.endsAt ?? now),
    now,
  );
  await sub.update(
    {
      planId,
      billingCycle: cycle,
      status: 'active',
      currentPeriodStart: start,
      endsAt: addCycle(start, cycle),
      pendingPlanId: null,
      pendingBillingCycle: null,
      lastNotice: null,
    },
    { transaction },
  );
  const plan = await Plan.findByPk(planId, { transaction });
  if (plan) sub.plan = plan;
  sub.pendingPlan = null;
  const carried = new Set(meta.addonIds ?? []);
  const active = await SubscriptionAddon.findAll({
    where: { instituteId: sub.instituteId, status: 'active' },
    transaction,
  });
  for (const a of active) {
    if (!isRecurringAddon(a.kind)) continue;
    const entry = plan && carried.has(a.id) ? catalogueEntry(plan, a.kind, a.moduleKey) : undefined;
    if (!entry) await a.update({ status: 'expired' }, { transaction });
    else
      await a.update(
        { unitPricePaise: addonPrice(entry, cycle), billingCycle: cycle, subscriptionId: sub.id },
        { transaction },
      );
  }
}

/** Paid (or free) plan change: same cycle keeps the term, a cycle change starts a new one now. */
async function applyPlanChange(sub: Subscription, meta: InvoiceMeta, transaction: Transaction, now: Date) {
  const plan = meta.planId ? await Plan.findByPk(meta.planId, { transaction }) : null;
  if (!plan) return;
  const cycle = meta.billingCycle ?? sub.billingCycle;
  await sub.update(
    {
      planId: plan.id,
      billingCycle: cycle,
      pendingPlanId: null,
      pendingBillingCycle: null,
      ...(meta.keepPeriod
        ? {}
        : {
            status: 'active' as const,
            currentPeriodStart: now,
            endsAt: addCycle(now, cycle),
            lastNotice: null,
          }),
    },
    { transaction },
  );
  sub.plan = plan;
  sub.pendingPlan = null;
  const carried = new Set(meta.addonIds ?? []);
  const active = await SubscriptionAddon.findAll({
    where: { instituteId: sub.instituteId, status: 'active' },
    transaction,
  });
  for (const a of active) {
    if (!isRecurringAddon(a.kind)) continue;
    const entry = catalogueEntry(plan, a.kind, a.moduleKey);
    if (meta.keepPeriod) {
      if (!entry && !a.cancelAtPeriodEnd) await a.update({ cancelAtPeriodEnd: true }, { transaction });
    } else if (entry && carried.has(a.id))
      await a.update({ unitPricePaise: addonPrice(entry, cycle), billingCycle: cycle }, { transaction });
    else await a.update({ status: 'expired' }, { transaction });
  }
  await refreshOpenRenewal(sub, transaction, now);
}

async function activateAddons(
  sub: Subscription | null,
  instituteId: number,
  meta: InvoiceMeta,
  transaction: Transaction,
  now: Date,
) {
  const ids = meta.addonIds ?? [];
  if (!ids.length) return;
  const addons = await SubscriptionAddon.findAll({
    where: { instituteId, id: { [Op.in]: ids }, status: 'pending' },
    transaction,
  });
  let recurring = false;
  for (const a of addons) {
    await a.update(
      { status: 'active', startsAt: now, periodMonth: a.kind === 'ai_credits' ? monthKey(now) : null },
      { transaction },
    );
    if (isRecurringAddon(a.kind)) recurring = true;
  }
  if (recurring && sub) await refreshOpenRenewal(sub, transaction, now);
}

/**
 * Applies what a fully paid (or credit-settled) invoice bought: renewal, plan change or add-ons.
 * Call inside the transaction that marked the invoice paid.
 */
export async function applyInvoicePaid(
  inv: SubscriptionInvoice,
  transaction: Transaction,
  now = new Date(),
): Promise<void> {
  const meta = inv.meta ?? {};
  if (!inv.instituteId || !meta.action || meta.action === 'overage' || meta.action === 'manual') return;
  const sub = await getCurrentSubscription(inv.instituteId, { transaction, lock: true });
  if (meta.action === 'addon') await activateAddons(sub, inv.instituteId, meta, transaction, now);
  else if (!sub || sub.id !== inv.subscriptionId)
    logger.warn({ invoiceId: inv.id }, 'Paid invoice belongs to a replaced subscription; nothing applied');
  else if (meta.action === 'renew') await applyRenewal(sub, meta, transaction, now);
  else if (meta.action === 'plan_change') await applyPlanChange(sub, meta, transaction, now);
  invalidateAccess(inv.instituteId);
}

// ------------------------------------------------------------------ plan changes

type ChangeMode = 'same' | 'trial' | 'lapsed' | 'invoice' | 'immediate' | 'schedule';

interface PlannedChange {
  mode: ChangeMode;
  preview: PlanChangePreviewDto;
  lines: InvoiceLineInput[];
  meta: InvoiceMeta;
}

async function planChange(
  sub: Subscription,
  target: Plan,
  cycle: BillingCycle,
  now: Date,
  transaction?: Transaction,
): Promise<PlannedChange> {
  if (!sub.endsAt) throw Conflict(MANAGED_MESSAGE, 'PLAN_MANAGED');
  if (sub.suspendedAt)
    throw Conflict('The subscription is suspended. Contact support.', 'SUBSCRIPTION_SUSPENDED');
  assertCycleOffered(target, cycle);
  const current = sub.plan!;
  const [profile, policy] = await Promise.all([getBillingProfile(), getBillingPolicy()]);
  const blockedBy = await usageBlockers(sub, target, now, transaction);
  const oldPrice = priceFor(current, sub.billingCycle);
  const newPrice = priceFor(target, cycle);
  const meta: InvoiceMeta = { action: 'plan_change', planId: target.id, billingCycle: cycle };
  let mode: ChangeMode;
  let kind: PlanChangePreviewDto['kind'];
  let effective: PlanChangePreviewDto['effective'] = 'now';
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  let lines: InvoiceLineInput[] = [];
  let message: string;

  if (target.id === sub.planId && cycle === sub.billingCycle) {
    mode = 'same';
    kind = 'same';
    message = sub.pendingPlanId
      ? 'You are on this plan. Cancel the scheduled change to stay on it.'
      : 'You are already on this plan.';
  } else if (sub.status === 'trial') {
    mode = 'trial';
    kind = 'trial';
    periodStart = sub.startsAt;
    periodEnd = sub.endsAt;
    message = `Your trial switches to ${target.name} now, free of charge.`;
  } else if (sub.endsAt <= now) {
    mode = 'lapsed';
    kind = newPrice >= oldPrice ? 'upgrade' : 'downgrade';
    const access = computeAccessState(sub, policy, now);
    periodStart = access.state === 'grace' ? sub.endsAt : now;
    periodEnd = addCycle(periodStart, cycle);
    const addonTotal = (await carriedAddons(sub, target, transaction)).reduce(
      (s, c) => s + addonPrice(c.entry, cycle) * c.addon.quantity,
      0,
    );
    lines = [{ description: target.name, unitPricePaise: newPrice + addonTotal }];
    message = `Your subscription has ended. Pay the renewal invoice to continue on ${target.name}.`;
  } else {
    const f = remainingFraction(sub, now);
    if (cycle === sub.billingCycle) {
      const charge = Math.round((newPrice - oldPrice) * f);
      if (charge > 0) {
        mode = 'invoice';
        kind = 'upgrade';
        periodStart = now;
        periodEnd = sub.endsAt;
        Object.assign(meta, {
          keepPeriod: true,
          periodStart: now.toISOString(),
          periodEnd: sub.endsAt.toISOString(),
        });
        lines = [
          {
            description: `${current.name} to ${target.name} (${cycle}), prorated ${formatDay(now)} to ${formatDay(
              sub.endsAt,
            )}`,
            unitPricePaise: charge,
            itemType: 'proration',
          },
        ];
        message = `Pay the prorated difference now to switch to ${target.name} immediately.`;
      } else if (newPrice >= oldPrice) {
        mode = 'immediate';
        kind = 'upgrade';
        meta.keepPeriod = true;
        periodStart = now;
        periodEnd = sub.endsAt;
        message = `Switches to ${target.name} now at no extra charge.`;
      } else {
        mode = 'schedule';
        kind = 'downgrade';
        effective = 'period_end';
        periodStart = sub.endsAt;
        periodEnd = addCycle(sub.endsAt, cycle);
        message = `${target.name} (${cycle}) starts when the current period ends on ${formatDay(sub.endsAt)}.`;
      }
    } else {
      // Billing cycle change: a new term starts now, less the unused value of the current one.
      periodStart = now;
      periodEnd = addCycle(now, cycle);
      let credit = Math.round(oldPrice * f);
      const items: { line: InvoiceLineInput; amount: number }[] = [
        {
          line: {
            description: `${target.name} plan (${cycle}), ${formatDay(periodStart)} to ${formatDay(periodEnd)}`,
            unitPricePaise: newPrice,
            itemType: 'plan',
          },
          amount: newPrice,
        },
      ];
      const carried = await carriedAddons(sub, target, transaction);
      const carriedIds = new Set(carried.map((c) => c.addon.id));
      const active = await SubscriptionAddon.findAll({
        where: { instituteId: sub.instituteId, status: 'active' },
        transaction,
      });
      for (const a of active)
        if (isRecurringAddon(a.kind)) credit += Math.round(a.unitPricePaise * a.quantity * f);
      for (const { addon, entry } of carried) {
        const unit = addonPrice(entry, cycle);
        items.push({
          line: {
            description: addonLabel(addon),
            quantity: addon.quantity,
            unitPricePaise: unit,
            itemType: `addon:${addon.kind}`,
          },
          amount: unit * addon.quantity,
        });
      }
      const gross = items.reduce((s, i) => s + i.amount, 0);
      if (gross - credit > 0) {
        mode = 'invoice';
        kind = 'upgrade';
        Object.assign(meta, {
          keepPeriod: false,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          addonIds: [...carriedIds],
        });
        let left = credit;
        lines = items.map(({ line, amount }) => {
          const use = Math.min(left, amount);
          left -= use;
          return {
            ...line,
            description: use
              ? `${line.description} (less Rs. ${formatRupees(use)} unused credit)`
              : line.description,
            amountPaise: amount - use,
          };
        });
        message = `Starts a new ${cycle} term now; the unused part of the current term is credited.`;
      } else {
        mode = 'schedule';
        kind = 'downgrade';
        effective = 'period_end';
        periodStart = sub.endsAt;
        periodEnd = addCycle(sub.endsAt, cycle);
        message = `${target.name} (${cycle}) starts when the current period ends on ${formatDay(sub.endsAt)}.`;
      }
    }
  }
  if (blockedBy.length && mode !== 'same')
    message = `Reduce usage before switching to ${target.name}: ${blockedBy
      .map((b) => `${METRIC_LABELS[b.metric]} ${b.used} of ${b.limit}`)
      .join(', ')}.`;
  const subtotal =
    mode === 'invoice' || mode === 'lapsed'
      ? lines.reduce((s, l) => s + (l.amountPaise ?? l.unitPricePaise * (l.quantity ?? 1)), 0)
      : 0;
  const tax = Math.round((subtotal * Math.max(0, Math.round(profile.gstRatePercent * 100))) / 10000);
  return {
    mode,
    lines,
    meta,
    preview: {
      kind,
      effective,
      subtotalPaise: subtotal,
      taxPaise: tax,
      totalPaise: subtotal + tax,
      periodStart: iso(periodStart),
      periodEnd: iso(periodEnd),
      blockedBy,
      message,
    },
  };
}

export async function previewPlanChange(
  instituteId: number,
  planId: number,
  cycle: BillingCycle,
  now = new Date(),
): Promise<PlanChangePreviewDto> {
  const sub = await getCurrentSubscription(instituteId);
  if (!sub?.plan) throw Conflict('The institute has no subscription', 'NO_SUBSCRIPTION');
  return (await planChange(sub, await loadTargetPlan(planId), cycle, now)).preview;
}

/**
 * Changes plan or billing cycle: trial switches and free changes apply now, upgrades are invoiced
 * (prorated) and applied when paid, downgrades are scheduled for the end of the period. Refused
 * while usage exceeds the target plan's limits.
 */
export async function changePlan(
  instituteId: number,
  planId: number,
  cycle: BillingCycle,
  userId: number | null,
  now = new Date(),
): Promise<BillingActionResultDto> {
  const result = await withTransaction(async (transaction): Promise<BillingActionResultDto> => {
    const sub = await requireSubscription(instituteId, transaction);
    const target = await loadTargetPlan(planId, transaction);
    const change = await planChange(sub, target, cycle, now, transaction);
    if (change.mode === 'same') throw BadRequest(change.preview.message);
    if (change.preview.blockedBy.length)
      throw Conflict(change.preview.message, 'DOWNGRADE_BLOCKED', { blockedBy: change.preview.blockedBy });
    await voidSuperseded(
      await openActionInvoices(sub, 'plan_change', transaction),
      'Replaced by another plan change',
      transaction,
    );
    switch (change.mode) {
      case 'trial':
        await sub.update(
          { planId: target.id, billingCycle: cycle, pendingPlanId: null, pendingBillingCycle: null },
          { transaction },
        );
        sub.plan = target;
        sub.pendingPlan = null;
        await refreshOpenRenewal(sub, transaction, now);
        return { applied: true, invoice: null, message: change.preview.message };
      case 'immediate':
        await applyPlanChange(sub, change.meta, transaction, now);
        return { applied: true, invoice: null, message: change.preview.message };
      case 'schedule':
      case 'lapsed': {
        const differs = target.id !== sub.planId || cycle !== sub.billingCycle;
        await sub.update(
          { pendingPlanId: differs ? target.id : null, pendingBillingCycle: differs ? cycle : null },
          { transaction },
        );
        sub.pendingPlan = differs ? target : null;
        if (change.mode === 'schedule') {
          await refreshOpenRenewal(sub, transaction, now);
          return { applied: true, invoice: null, message: change.preview.message };
        }
        const open = await openActionInvoices(sub, 'renew', transaction);
        const invoice = open.every(untouched)
          ? (await voidSuperseded(open, 'Replaced after a plan change', transaction),
            await issueRenewal(sub, transaction, now, userId))
          : open[0];
        return {
          applied: !invoice,
          invoice: invoice ? toInvoiceDto(invoice) : null,
          message: invoice ? change.preview.message : `Renewed on ${target.name}.`,
        };
      }
      default: {
        const invoice = await createInvoice(
          {
            instituteId,
            subscriptionId: sub.id,
            kind: 'upgrade',
            lines: change.lines,
            periodStart: change.preview.periodStart ? new Date(change.preview.periodStart) : null,
            periodEnd: change.preview.periodEnd ? new Date(change.preview.periodEnd) : null,
            meta: change.meta,
            createdBy: userId,
            now,
          },
          transaction,
        );
        return { applied: false, invoice: toInvoiceDto(invoice), message: change.preview.message };
      }
    }
  });
  invalidateAccess(instituteId);
  await audit({
    action: 'subscription.plan_change',
    entityType: 'subscription',
    instituteId,
    metadata: { planId, billingCycle: cycle, applied: result.applied, invoiceId: result.invoice?.id ?? null },
  });
  return result;
}

export async function cancelPendingChange(instituteId: number, now = new Date()): Promise<void> {
  await withTransaction(async (transaction) => {
    const sub = await requireSubscription(instituteId, transaction);
    if (!sub.pendingPlanId && !sub.pendingBillingCycle)
      throw Conflict('No plan change is scheduled', 'NO_PENDING_CHANGE');
    await sub.update({ pendingPlanId: null, pendingBillingCycle: null }, { transaction });
    sub.pendingPlan = null;
    await refreshOpenRenewal(sub, transaction, now);
  });
  invalidateAccess(instituteId);
  await audit({ action: 'subscription.plan_change_cancelled', entityType: 'subscription', instituteId });
}

// ------------------------------------------------------------------ add-ons

export interface AddonPurchaseInput {
  kind: AddonKind;
  moduleKey?: string | null;
  quantity: number;
}

/**
 * Buys an add-on pack: recurring packs are prorated to the end of the period and renew with the
 * subscription; AI credit packs are one-time tokens for the current month. Active once paid.
 */
export async function purchaseAddon(
  instituteId: number,
  input: AddonPurchaseInput,
  userId: number | null,
  now = new Date(),
): Promise<BillingActionResultDto> {
  const result = await withTransaction(async (transaction): Promise<BillingActionResultDto> => {
    const sub = await requireSubscription(instituteId, transaction);
    const plan = sub.plan!;
    const entry = catalogueEntry(plan, input.kind, input.moduleKey);
    if (!entry) throw BadRequest('This add-on is not offered with your plan');
    const recurring = isRecurringAddon(input.kind);
    const state = computeAccessState(sub, await getBillingPolicy(), now).state;
    if (state === 'suspended' || state === 'restricted' || state === 'grace')
      throw Conflict('Renew the subscription before buying add-ons', 'SUBSCRIPTION_LAPSED');
    if (recurring) {
      if (!sub.endsAt) throw Conflict(MANAGED_MESSAGE, 'PLAN_MANAGED');
      if (sub.status === 'trial')
        throw Conflict('Recurring add-ons can be bought once the subscription is paid', 'TRIAL_ADDON');
    }
    const quantity = input.kind === 'module' ? 1 : input.quantity;
    if (input.kind === 'module') {
      const included = await includedLimitsFor(sub, plan, now, transaction);
      if (included.enabledModules === null || included.enabledModules.includes(entry.moduleKey ?? ''))
        throw Conflict('This module is already enabled', 'MODULE_INCLUDED');
      const pending = await SubscriptionAddon.findOne({
        where: { instituteId, kind: 'module', moduleKey: entry.moduleKey ?? null, status: 'pending' },
        transaction,
      });
      if (pending) throw Conflict('This module is already awaiting payment', 'ADDON_PENDING');
    }
    const unit = addonPrice(entry, sub.billingCycle);
    const fraction = recurring ? remainingFraction(sub, now) : 1;
    const amount = Math.round(unit * quantity * fraction);
    const addon = await SubscriptionAddon.create(
      {
        instituteId,
        subscriptionId: sub.id,
        kind: input.kind,
        moduleKey: input.kind === 'module' ? (entry.moduleKey ?? null) : null,
        quantity,
        unitSize: input.kind === 'module' ? 1 : entry.unitSize,
        unitPricePaise: unit,
        billingCycle: sub.billingCycle,
        status: 'pending',
        startsAt: null,
        periodMonth: null,
        invoiceId: null,
        createdBy: userId,
      },
      { transaction },
    );
    const meta: InvoiceMeta = { action: 'addon', addonIds: [addon.id] };
    if (amount <= 0) {
      await activateAddons(sub, instituteId, meta, transaction, now);
      return { applied: true, invoice: null, message: `${addonLabel(addon)} added.` };
    }
    const invoice = await createInvoice(
      {
        instituteId,
        subscriptionId: sub.id,
        kind: 'addon',
        lines: [
          {
            description: recurring
              ? `${addonLabel(addon)}, prorated ${formatDay(now)} to ${formatDay(sub.endsAt!)}`
              : `${addonLabel(addon)} for ${monthLabel(now)}`,
            quantity,
            unitPricePaise: Math.round(unit * fraction),
            amountPaise: amount,
            itemType: `addon:${input.kind}`,
          },
        ],
        periodStart: recurring ? now : null,
        periodEnd: recurring ? sub.endsAt : null,
        meta,
        createdBy: userId,
        now,
      },
      transaction,
    );
    await addon.update({ invoiceId: invoice.id }, { transaction });
    return {
      applied: false,
      invoice: toInvoiceDto(invoice),
      message: 'Pay the invoice to activate the add-on.',
    };
  });
  await audit({
    action: 'subscription.addon_purchased',
    entityType: 'subscription',
    instituteId,
    metadata: { ...input, invoiceId: result.invoice?.id ?? null },
  });
  return result;
}

/** Cancels an unpaid add-on (voids its invoice) or stops a recurring one at the end of the period. */
export async function cancelAddon(instituteId: number, addonId: number, now = new Date()) {
  const addon = await withTransaction(async (transaction) => {
    const a = await SubscriptionAddon.findOne({
      where: { instituteId, id: addonId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!a) throw NotFound('Add-on');
    if (a.status === 'pending') {
      const inv = a.invoiceId
        ? await SubscriptionInvoice.findOne({ where: { instituteId, id: a.invoiceId }, transaction })
        : null;
      if (inv?.status === 'open') {
        if (!untouched(inv))
          throw Conflict('The add-on invoice is partly paid. Contact support.', 'INVOICE_HAS_PAYMENTS');
        await voidInvoice(inv.id, 'Add-on cancelled before payment', transaction);
      }
      await a.update({ status: 'cancelled' }, { transaction });
      return a;
    }
    if (a.status !== 'active') throw Conflict('The add-on is not active', 'ADDON_NOT_ACTIVE');
    if (!isRecurringAddon(a.kind))
      throw Conflict('AI credit packs cannot be cancelled', 'ADDON_NOT_CANCELLABLE');
    if (!a.cancelAtPeriodEnd) {
      await a.update({ cancelAtPeriodEnd: true }, { transaction });
      const sub = await getCurrentSubscription(instituteId, { transaction, lock: true });
      if (sub) await refreshOpenRenewal(sub, transaction, now);
    }
    return a;
  });
  invalidateAccess(instituteId);
  await audit({
    action: 'subscription.addon_cancelled',
    entityType: 'subscription_addon',
    entityId: addonId,
    instituteId,
  });
  return addon;
}

/** Returns the open renewal invoice, issuing one when there is none (pay early or after lapse). */
export async function requestRenewal(
  instituteId: number,
  userId: number | null,
  now = new Date(),
): Promise<BillingActionResultDto> {
  const invoice = await withTransaction(async (transaction) => {
    const sub = await requireSubscription(instituteId, transaction);
    if (!sub.endsAt) throw Conflict('Your subscription does not expire', 'PLAN_MANAGED');
    if (sub.suspendedAt)
      throw Conflict('The subscription is suspended. Contact support.', 'SUBSCRIPTION_SUSPENDED');
    const open = await openActionInvoices(sub, 'renew', transaction);
    if (open.length) return open[0];
    return issueRenewal(sub, transaction, now, userId);
  });
  invalidateAccess(instituteId);
  return invoice
    ? { applied: false, invoice: toInvoiceDto(invoice), message: 'Pay the invoice to renew.' }
    : { applied: true, invoice: null, message: 'Renewed.' };
}

/** Sweep: issues the renewal invoice once per term, `renewalLeadDays` before the period ends. */
export async function issueDueRenewal(sub: Subscription, renewalLeadDays: number, now: Date) {
  if (!sub.endsAt || sub.suspendedAt) return null;
  if (sub.endsAt.getTime() - now.getTime() > renewalLeadDays * DAY_MS) return null;
  const issued = await SubscriptionInvoice.count({
    where: {
      instituteId: sub.instituteId,
      subscriptionId: sub.id,
      kind: { [Op.in]: ['renewal', 'subscription'] },
      periodStart: { [Op.gte]: sub.endsAt },
    },
  });
  if (issued) return null;
  return withTransaction(async (transaction) => {
    const locked = await getCurrentSubscription(sub.instituteId, { transaction, lock: true });
    if (!locked?.plan || locked.id !== sub.id) return null;
    if ((await openActionInvoices(locked, 'renew', transaction)).length) return null;
    return issueRenewal(locked, transaction, now);
  });
}

// ------------------------------------------------------------------ super admin actions

export async function extendTrial(instituteId: number, days: number, now = new Date()) {
  const sub = await withTransaction(async (transaction) => {
    const s = await requireSubscription(instituteId, transaction);
    if (s.status !== 'trial' || !s.endsAt) throw Conflict('The institute is not on a trial', 'NOT_TRIAL');
    const base = s.endsAt > now ? s.endsAt : now;
    await s.update(
      { endsAt: addDays(base, days), trialExtendedDays: (s.trialExtendedDays ?? 0) + days, lastNotice: null },
      { transaction },
    );
    await refreshOpenRenewal(s, transaction, now);
    return s;
  });
  invalidateAccess(instituteId);
  await audit({
    action: 'subscription.trial_extended',
    entityType: 'subscription',
    entityId: sub.id,
    instituteId,
    metadata: { days, endsAt: sub.endsAt?.toISOString() },
  });
  return sub;
}

export async function suspendSubscription(instituteId: number, reason: string, now = new Date()) {
  const sub = await withTransaction(async (transaction) => {
    const s = await requireSubscription(instituteId, transaction);
    if (s.suspendedAt) throw Conflict('The subscription is already suspended', 'ALREADY_SUSPENDED');
    await s.update({ suspendedAt: now, suspendReason: reason }, { transaction });
    return s;
  });
  invalidateAccess(instituteId);
  await audit({
    action: 'subscription.suspended',
    entityType: 'subscription',
    entityId: sub.id,
    instituteId,
    metadata: { reason },
  });
  return sub;
}

/** Lifts a manual suspension and/or extends a lapsed subscription by `extendDays`. */
export async function reactivateSubscription(
  instituteId: number,
  extendDays: number | null,
  now = new Date(),
) {
  const sub = await withTransaction(async (transaction) => {
    const s = await requireSubscription(instituteId, transaction);
    if (!s.suspendedAt && !extendDays)
      throw BadRequest('The subscription is not suspended; give the number of days to extend it by');
    const extend =
      extendDays && s.endsAt
        ? {
            endsAt: addDays(s.endsAt > now ? s.endsAt : now, extendDays),
            lastNotice: null,
            ...(s.status === 'past_due' || s.status === 'expired' ? { status: 'active' as const } : {}),
          }
        : {};
    await s.update({ suspendedAt: null, suspendReason: null, ...extend }, { transaction });
    return s;
  });
  invalidateAccess(instituteId);
  await audit({
    action: 'subscription.reactivated',
    entityType: 'subscription',
    entityId: sub.id,
    instituteId,
    metadata: { extendDays, endsAt: sub.endsAt?.toISOString() ?? null },
  });
  return sub;
}

export interface AssignSubscriptionInput {
  planId: number;
  status: 'trial' | 'active';
  billingCycle: BillingCycle;
  endsAt?: Date | null;
  limitOverrides?: Partial<PlanLimits> | null;
}

/**
 * Super admin: replaces the current subscription. Unpaid renewal / plan change invoices of the
 * replaced one are voided and add-ons move to the new subscription.
 */
export async function assignSubscription(
  instituteId: number,
  input: AssignSubscriptionInput,
  now = new Date(),
) {
  const sub = await withTransaction(async (transaction) => {
    const old = await Subscription.findAll({
      where: { instituteId, status: { [Op.in]: CURRENT_STATUSES } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const s of old) {
      await s.update(
        { status: 'cancelled', endsAt: s.endsAt && s.endsAt < now ? s.endsAt : now },
        { transaction },
      );
      const open = await SubscriptionInvoice.findAll({
        where: { instituteId, subscriptionId: s.id, status: 'open' },
        transaction,
      });
      await voidSuperseded(
        open.filter((i) => i.meta?.action === 'renew' || i.meta?.action === 'plan_change'),
        'Subscription replaced by the platform team',
        transaction,
      );
    }
    const created = await Subscription.create(
      {
        instituteId,
        planId: input.planId,
        status: input.status,
        billingCycle: input.billingCycle,
        startsAt: now,
        endsAt: input.endsAt ?? null,
        limitOverrides: input.limitOverrides ?? null,
        currentPeriodStart: now,
      },
      { transaction },
    );
    await SubscriptionAddon.update(
      { subscriptionId: created.id },
      { where: { instituteId, status: { [Op.in]: ['pending', 'active'] } }, transaction },
    );
    return created;
  });
  invalidateAccess(instituteId);
  return sub;
}

// ------------------------------------------------------------------ overview

export async function billingOverview(
  instituteId: number,
  canManage: boolean,
  now = new Date(),
): Promise<BillingOverviewDto> {
  const [sub, policy, profile] = await Promise.all([
    getCurrentSubscription(instituteId),
    getBillingPolicy(),
    getBillingProfile(),
  ]);
  const access = computeAccessState(sub, policy, now);
  const plan = sub?.plan ?? null;
  const included = sub && plan ? await includedLimitsFor(sub, plan, now) : null;
  const [usage, ai, addons, plans, openInvoices] = await Promise.all([
    currentUsage(instituteId, now),
    aiQuota(instituteId, included, plan, now),
    SubscriptionAddon.findAll({
      where: { instituteId, status: { [Op.in]: ['pending', 'active'] } },
      order: [['id', 'DESC']],
    }),
    Plan.findAll({
      where: { isActive: true },
      order: [
        ['priceMonthlyPaise', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
    SubscriptionInvoice.findAll({
      where: { instituteId, status: 'open' },
      order: [
        ['dueDate', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
  ]);
  const month = monthKey(now);
  return {
    status: toStatusDto(access, canManage, policy.renewalLeadDays, now),
    subscription: sub ? toSubscriptionDto(sub) : null,
    plan: plan ? toPlanDto(plan) : null,
    selfService: !!sub?.endsAt,
    limits: included,
    usage: usageMetrics(usage, included, plan),
    ai,
    addons: addons
      .filter((a) => a.kind !== 'ai_credits' || a.status === 'pending' || a.periodMonth === month)
      .map(toAddonDto),
    addonCatalogue: plan?.addons ?? [],
    plans: plans.map((p) => toPlanDto(p)),
    openInvoices: openInvoices.map(toInvoiceDto),
    policy,
    gstRatePercent: profile.gstRatePercent,
  };
}
