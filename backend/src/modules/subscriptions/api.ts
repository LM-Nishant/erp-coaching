/**
 * Public surface of the subscriptions module for other modules (see CONTRIBUTING.md). Existing
 * callers of `subscription.service` keep working; new cross-module code should import from here.
 */
import { Op, QueryTypes } from 'sequelize';
import type { PlanLimits, RevenuePointDto, SubscriptionAccessState } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Institute } from '../institutes/institute.model';
import {
  Plan,
  Subscription,
  SubscriptionAddon,
  SubscriptionCreditNote,
  SubscriptionInvoice,
  SubscriptionPayment,
} from './models';
import { getBillingPolicy } from './billing-settings';
import { invoiceBalance, platform } from './invoices.service';
import { CURRENT_STATUSES, computeAccessState } from './subscription.service';
import { billingDate } from './util';

export {
  assertWithinLimit,
  getAccessState,
  getPlanLimits,
  invalidateAccess,
  isModuleEnabled,
} from './subscription.service';
export { registerUsageCounter, type UsageCounter } from './usage.service';
export { setSaasGatewayResolver, type SaasGatewayConfig, type SaasGatewayResolver } from './payments.service';

// ------------------------------------------------------------------ Reports hand-off (spec 4.17)

const monthOf = (d: Date | string) => `${(typeof d === 'string' ? d : billingDate(d)).slice(0, 7)}-01`;

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * SaaS revenue per month (billing timezone), `from`/`to` as `YYYY-MM-DD` (inclusive months):
 * invoiced = non-void invoices by issue date, collected = successful payments by payment date,
 * credited = credit notes by date.
 */
export async function revenueByMonth(range: { from: string; to: string }): Promise<RevenuePointDto[]> {
  const start = `${range.from.slice(0, 7)}-01`;
  const months = monthsBetween(start, range.to);
  const points = new Map(
    months.map((month) => [month, { month, invoicedPaise: 0, collectedPaise: 0, creditedPaise: 0 }]),
  );
  // Timestamps are filtered with a day of slack on both sides, then bucketed in the billing timezone.
  const tsFrom = new Date(new Date(`${start}T00:00:00Z`).getTime() - 86_400_000);
  const tsTo = new Date(
    new Date(`${months[months.length - 1] ?? start}T00:00:00Z`).getTime() + 32 * 86_400_000,
  );
  const [invoices, payments, notes] = await Promise.all([
    SubscriptionInvoice.findAll(
      platform({
        where: { status: { [Op.ne]: 'void' }, issueDate: { [Op.gte]: start, [Op.lte]: range.to } },
        attributes: ['issueDate', 'totalPaise'],
        raw: true,
      }),
    ),
    SubscriptionPayment.findAll(
      platform({
        where: { status: 'success', paidAt: { [Op.gte]: tsFrom, [Op.lt]: tsTo } },
        attributes: ['paidAt', 'amountPaise'],
        raw: true,
      }),
    ),
    SubscriptionCreditNote.findAll(
      platform({
        where: { createdAt: { [Op.gte]: tsFrom, [Op.lt]: tsTo } },
        attributes: ['createdAt', 'amountPaise'],
        raw: true,
      }),
    ),
  ]);
  for (const i of invoices) {
    const p = points.get(monthOf(i.issueDate));
    if (p) p.invoicedPaise += i.totalPaise;
  }
  for (const pay of payments) {
    const p = pay.paidAt ? points.get(monthOf(new Date(pay.paidAt))) : undefined;
    if (p) p.collectedPaise += pay.amountPaise;
  }
  for (const n of notes) {
    const p = points.get(monthOf(new Date(n.createdAt)));
    if (p) p.creditedPaise += n.amountPaise;
  }
  return [...points.values()];
}

async function currentSubscriptions(now: Date) {
  const subs = await Subscription.findAll(
    platform({
      where: { status: { [Op.in]: CURRENT_STATUSES }, startsAt: { [Op.lte]: now } },
      order: [
        ['startsAt', 'DESC'],
        ['id', 'DESC'],
      ] as [string, string][],
    }),
  );
  const latest = new Map<number, Subscription>();
  for (const s of subs) if (!latest.has(s.instituteId)) latest.set(s.instituteId, s);
  return [...latest.values()];
}

/** Institutes per access state (trial, active, grace, restricted, suspended, none). */
export async function subscriptionsByState(
  now = new Date(),
): Promise<{ state: SubscriptionAccessState; count: number }[]> {
  const [subs, policy, institutes] = await Promise.all([
    currentSubscriptions(now),
    getBillingPolicy(),
    Institute.count(),
  ]);
  const counts = new Map<SubscriptionAccessState, number>();
  for (const s of subs) {
    const state = computeAccessState(s, policy, now).state;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  counts.set('none', Math.max(0, institutes - subs.length));
  return (['trial', 'active', 'grace', 'restricted', 'suspended', 'none'] as const).map((state) => ({
    state,
    count: counts.get(state) ?? 0,
  }));
}

const monthlyValue = (paise: number, cycle: string) => (cycle === 'yearly' ? Math.round(paise / 12) : paise);

/**
 * Current subscriptions per plan with monthly recurring revenue (paid, non-trial subscriptions:
 * plan price plus recurring add-ons, yearly normalised to a month).
 */
export async function subscriptionsByPlan(now = new Date()) {
  const [subs, plans, addons] = await Promise.all([
    currentSubscriptions(now),
    Plan.findAll(),
    SubscriptionAddon.findAll(platform({ where: { status: 'active', kind: { [Op.ne]: 'ai_credits' } } })),
  ]);
  const addonMrr = new Map<number, number>();
  for (const a of addons)
    addonMrr.set(
      a.subscriptionId,
      (addonMrr.get(a.subscriptionId) ?? 0) + monthlyValue(a.unitPricePaise * a.quantity, a.billingCycle),
    );
  return plans.map((plan) => {
    const mine = subs.filter((s) => s.planId === plan.id);
    const paying = mine.filter((s) => s.status !== 'trial' && !s.suspendedAt);
    const mrrPaise = paying.reduce(
      (sum, s) =>
        sum +
        monthlyValue(
          s.billingCycle === 'yearly' ? plan.priceYearlyPaise : plan.priceMonthlyPaise,
          s.billingCycle,
        ) +
        (addonMrr.get(s.id) ?? 0),
      0,
    );
    return {
      planId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      subscriptions: mine.length,
      trials: mine.filter((s) => s.status === 'trial').length,
      mrrPaise,
    };
  });
}

/** Headline SaaS numbers: MRR, receivables and subscription counts. */
export async function saasBillingKpis(now = new Date()) {
  const [byPlan, byState, open] = await Promise.all([
    subscriptionsByPlan(now),
    subscriptionsByState(now),
    SubscriptionInvoice.findAll(platform({ where: { status: 'open' } })),
  ]);
  const today = billingDate(now);
  const balance = (rows: SubscriptionInvoice[]) =>
    rows.reduce((s, i) => s + Math.max(0, invoiceBalance(i)), 0);
  return {
    mrrPaise: byPlan.reduce((s, p) => s + p.mrrPaise, 0),
    byState: Object.fromEntries(byState.map((s) => [s.state, s.count])) as Record<
      SubscriptionAccessState,
      number
    >,
    openInvoices: open.length,
    receivablePaise: balance(open),
    overduePaise: balance(open.filter((i) => i.dueDate < today)),
  };
}

/**
 * Latest usage snapshot per institute on or before `date` (default today), for usage reports.
 * Snapshots are taken by the hourly billing sweep.
 */
export async function usageSummary(opts: { date?: string; instituteId?: number } = {}) {
  const date = opts.date ?? billingDate();
  const rows = await getSequelize().query<{
    institute_id: number;
    institute_name: string | null;
    snapshot_date: string;
    students: number;
    branches: number;
    teachers: number;
    storage_mb: number;
    ai_tokens_month: number;
    limits: unknown;
  }>(
    `SELECT u.institute_id, i.name AS institute_name, u.snapshot_date, u.students, u.branches, u.teachers,
            u.storage_mb, u.ai_tokens_month, u.limits
       FROM subscription_usage u
       JOIN (SELECT institute_id, MAX(snapshot_date) AS d FROM subscription_usage
              WHERE snapshot_date <= :date ${opts.instituteId ? 'AND institute_id = :instituteId' : ''}
              GROUP BY institute_id) m ON m.institute_id = u.institute_id AND m.d = u.snapshot_date
       LEFT JOIN institutes i ON i.id = u.institute_id
      ORDER BY u.institute_id`,
    { replacements: { date, instituteId: opts.instituteId ?? null }, type: QueryTypes.SELECT },
  );
  return rows.map((r) => ({
    instituteId: r.institute_id,
    instituteName: r.institute_name ?? '',
    snapshotDate: String(r.snapshot_date).slice(0, 10),
    students: r.students,
    branches: r.branches,
    teachers: r.teachers,
    storageMb: r.storage_mb,
    aiTokensMonth: r.ai_tokens_month,
    limits: (typeof r.limits === 'string' ? JSON.parse(r.limits) : r.limits) as PlanLimits | null,
  }));
}
