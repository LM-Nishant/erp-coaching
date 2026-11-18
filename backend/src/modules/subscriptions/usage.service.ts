import { Op, fn, col } from 'sequelize';
import {
  METERED_METRICS,
  METRIC_LABELS,
  METRIC_LIMIT_KEY,
  type AiQuotaDto,
  type MeteredMetric,
  type OveragePrice,
  type PlanLimits,
  type UsageMetricDto,
} from '@erp/shared';
import { getContext, runWithContext } from '../../shared/context';
import { logger } from '../../infrastructure/logger';
import { Branch } from '../branches/branch.model';
import { FileObject } from '../files/file.model';
import { AiUsage } from '../ai/models';
import { Plan, Subscription, SubscriptionAddon, SubscriptionUsage } from './models';
import { getCurrentSubscription, includedLimitsFor } from './subscription.service';
import { isoDay, monthKey, nextMonth, startOfMonth } from './util';

export { startOfMonth } from './util';

/** Counts a metric for the institute in the current (tenant or system) context. */
export type UsageCounter = (instituteId: number) => Promise<number>;

const counters = new Map<'students' | 'teachers', UsageCounter>();

/**
 * Extension point: the students and hr modules register how they count billable seats (the same
 * rule their plan-limit checks use). Unregistered counters report 0.
 */
export function registerUsageCounter(metric: 'students' | 'teachers', counter: UsageCounter): void {
  counters.set(metric, counter);
}

async function countWith(metric: 'students' | 'teachers', instituteId: number): Promise<number> {
  const counter = counters.get(metric);
  if (!counter) return 0;
  if (getContext().instituteId === instituteId) return counter(instituteId);
  return runWithContext({ system: true, instituteId, allowedBranchIds: null }, () => counter(instituteId));
}

export type UsageNow = Record<MeteredMetric, number>;

export async function aiTokensBetween(instituteId: number, from: Date, to?: Date): Promise<number> {
  const createdAt = to ? { [Op.gte]: from, [Op.lt]: to } : { [Op.gte]: from };
  return Number((await AiUsage.sum('totalTokens', { where: { instituteId, createdAt } })) || 0);
}

/** Live usage of every metered metric (storage in MB, AI tokens this UTC month). */
export async function currentUsage(instituteId: number, now = new Date()): Promise<UsageNow> {
  const [students, teachers, branches, storageBytes, aiTokens] = await Promise.all([
    countWith('students', instituteId),
    countWith('teachers', instituteId),
    Branch.count({ where: { instituteId, status: 'active' } }),
    FileObject.sum('sizeBytes', { where: { instituteId } }),
    aiTokensBetween(instituteId, startOfMonth(now)),
  ]);
  return {
    students,
    teachers,
    branches,
    storageMb: Math.round(((Number(storageBytes) || 0) / 1048576) * 100) / 100,
    aiTokens,
  };
}

/** Legacy shape used by `GET /admin/institutes/:id/usage`. */
export async function usageFor(instituteId: number) {
  const u = await currentUsage(instituteId);
  return { ...u, aiTokensThisMonth: u.aiTokens };
}

export function usageMetrics(
  usage: UsageNow,
  included: PlanLimits | null,
  plan: Plan | null,
): UsageMetricDto[] {
  return METERED_METRICS.map((metric) => {
    const limit = included ? (included[METRIC_LIMIT_KEY[metric]] ?? null) : null;
    const used = usage[metric];
    return {
      metric,
      label: METRIC_LABELS[metric],
      used,
      included: limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
      percent: limit === null ? null : limit === 0 ? 100 : Math.round((used / limit) * 100),
      overage: (plan?.usagePricing?.[metric] as OveragePrice | undefined) ?? null,
    };
  });
}

/** AI quota for the current UTC month (spec §4.11): allowance, credit packs, usage by feature. */
export async function aiQuota(
  instituteId: number,
  included: PlanLimits | null,
  plan: Plan | null,
  now = new Date(),
): Promise<AiQuotaDto> {
  const from = startOfMonth(now);
  const [rows, credits] = await Promise.all([
    AiUsage.findAll({
      attributes: [
        'feature',
        [fn('SUM', col('total_tokens')), 'tokens'],
        [fn('COUNT', col('id')), 'requests'],
      ],
      where: { instituteId, createdAt: { [Op.gte]: from } },
      group: ['feature'],
      raw: true,
    }) as unknown as Promise<{ feature: string; tokens: string | number; requests: string | number }[]>,
    SubscriptionAddon.findAll({
      where: { instituteId, kind: 'ai_credits', status: 'active', periodMonth: monthKey(now) },
    }),
  ]);
  const byFeature = rows
    .map((r) => ({ feature: r.feature, tokens: Number(r.tokens) || 0, requests: Number(r.requests) || 0 }))
    .sort((a, b) => b.tokens - a.tokens);
  const used = byFeature.reduce((s, r) => s + r.tokens, 0);
  const limit = included ? included.aiTokensMonthly : null;
  return {
    usedThisMonth: used,
    includedThisMonth: limit,
    creditsThisMonth: credits.reduce((s, a) => s + a.unitSize * a.quantity, 0),
    remaining: limit === null ? null : Math.max(0, limit - used),
    requestsThisMonth: byFeature.reduce((s, r) => s + r.requests, 0),
    byFeature,
    overage: plan?.usagePricing?.aiTokens ?? null,
  };
}

/** Upserts today's (UTC) usage snapshot with the included limits of the day. */
export async function snapshotUsage(instituteId: number, now = new Date()): Promise<SubscriptionUsage> {
  const sub = await getCurrentSubscription(instituteId);
  const [usage, limits] = await Promise.all([
    currentUsage(instituteId, now),
    sub?.plan ? includedLimitsFor(sub, sub.plan, now) : null,
  ]);
  const snapshotDate = isoDay(now);
  const values = {
    students: usage.students,
    branches: usage.branches,
    teachers: usage.teachers,
    storageMb: Math.ceil(usage.storageMb),
    aiTokensMonth: usage.aiTokens,
    limits,
  };
  await SubscriptionUsage.upsert({ instituteId, snapshotDate, ...values });
  const row = await SubscriptionUsage.findOne({ where: { instituteId, snapshotDate } });
  if (!row) throw new Error('Usage snapshot not saved');
  return row;
}

export interface OverageLine {
  metric: MeteredMetric;
  used: number;
  included: number;
  over: number;
  units: number;
  unitPricePaise: number;
  amountPaise: number;
}

const SNAPSHOT_FIELD: Record<Exclude<MeteredMetric, 'aiTokens'>, keyof SubscriptionUsage> = {
  students: 'students',
  branches: 'branches',
  teachers: 'teachers',
  storageMb: 'storageMb',
};

/**
 * Overage of a completed UTC month: seat metrics and storage bill the month's peak above the
 * included limit (from daily snapshots), AI the month's tokens above allowance + credit packs.
 */
export async function computeOverage(sub: Subscription, plan: Plan, month: Date): Promise<OverageLine[]> {
  const pricing = plan.usagePricing ?? {};
  const from = startOfMonth(month);
  const to = nextMonth(from);
  const metrics = METERED_METRICS.filter((m) => pricing[m]);
  if (!metrics.length) return [];
  const snaps = await SubscriptionUsage.findAll({
    where: { instituteId: sub.instituteId, snapshotDate: { [Op.gte]: isoDay(from), [Op.lt]: isoDay(to) } },
  });
  const lines: OverageLine[] = [];
  for (const metric of metrics) {
    const price = pricing[metric]!;
    let used = 0;
    let included = 0;
    let over = 0;
    if (metric === 'aiTokens') {
      const limits = await includedLimitsFor(sub, plan, from);
      if (limits.aiTokensMonthly === null) continue;
      used = await aiTokensBetween(sub.instituteId, from, to);
      included = limits.aiTokensMonthly;
      over = used - included;
    } else {
      const key = METRIC_LIMIT_KEY[metric];
      for (const s of snaps) {
        const inc = s.limits?.[key];
        if (inc === null || inc === undefined) continue;
        const value = Number(s[SNAPSHOT_FIELD[metric]]) || 0;
        if (value - inc > over) {
          over = value - inc;
          used = value;
          included = inc;
        }
      }
    }
    if (over <= 0) continue;
    const units = Math.ceil(over / Math.max(1, price.unitSize));
    lines.push({
      metric,
      used,
      included,
      over,
      units,
      unitPricePaise: price.pricePaise,
      amountPaise: units * price.pricePaise,
    });
  }
  if (lines.length)
    logger.info(
      { instituteId: sub.instituteId, month: isoDay(from), lines },
      'subscription overage computed',
    );
  return lines;
}
