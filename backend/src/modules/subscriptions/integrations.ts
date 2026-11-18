import { Op } from 'sequelize';
import type { SaasBillingStatsDto } from '@erp/shared';
import { setPlatformBrandProvider, setSaasBillingStatsProvider, type SaasPeriod } from '../reports/api';
import {
  revenueByMonth,
  saasBillingKpis,
  subscriptionsByPlan,
  subscriptionsByState,
  usageSummary,
} from './api';
import { getBillingProfile } from './billing-settings';
import { platform } from './invoices.service';
import { SubscriptionPayment } from './models';

/** Successful SaaS payments received in `[start, end)`. */
async function collectedPaise(start: Date, end: Date): Promise<number> {
  const rows = await SubscriptionPayment.findAll(
    platform({
      where: { status: 'success', paidAt: { [Op.gte]: start, [Op.lt]: end } },
      attributes: ['amountPaise'],
      raw: true,
    }),
  );
  return rows.reduce((n, r) => n + r.amountPaise, 0);
}

/**
 * SaaS dashboard figures from billing: MRR from current paid subscriptions (plan price plus recurring
 * add-ons), revenue = payments collected in the period, outstanding = open invoice balances.
 */
export async function saasBillingStatsProvider(period: SaasPeriod): Promise<SaasBillingStatsDto> {
  const now = new Date();
  const [kpis, plans, byState, months, usage, revenueInPeriodPaise] = await Promise.all([
    saasBillingKpis(now),
    subscriptionsByPlan(now),
    subscriptionsByState(now),
    revenueByMonth({ from: period.from, to: period.to }),
    usageSummary({ date: period.to }),
    collectedPaise(period.start, period.end),
  ]);
  const byPlan = plans
    .map((p) => ({
      planId: p.planId,
      planName: p.planName,
      subscriptions: p.subscriptions - p.trials,
      mrrPaise: p.mrrPaise,
    }))
    .filter((p) => p.subscriptions > 0 || p.mrrPaise > 0)
    .sort((a, b) => b.mrrPaise - a.mrrPaise || a.planName.localeCompare(b.planName));
  return {
    source: 'billing',
    currency: 'INR',
    mrrPaise: kpis.mrrPaise,
    arrPaise: kpis.mrrPaise * 12,
    revenueInPeriodPaise,
    outstandingPaise: kpis.receivablePaise,
    paidSubscriptions: byPlan.reduce((n, p) => n + p.subscriptions, 0),
    byPlan,
    billing: {
      revenueByMonth: months,
      byState,
      openInvoices: kpis.openInvoices,
      overduePaise: kpis.overduePaise,
      usage: {
        snapshotDate: usage.reduce<string | null>(
          (d, u) => (!d || u.snapshotDate > d ? u.snapshotDate : d),
          null,
        ),
        institutes: usage.length,
        students: usage.reduce((n, u) => n + u.students, 0),
        storageMb: usage.reduce((n, u) => n + u.storageMb, 0),
        aiTokensMonth: usage.reduce((n, u) => n + u.aiTokensMonth, 0),
      },
    },
  };
}

/** The platform brand on SaaS documents is the billing profile's legal name. */
export const platformBrandName = async () => (await getBillingProfile()).legalName;

/** Wires SaaS billing into other modules; called from `onReady`. */
export function registerSubscriptionIntegrations(): void {
  setSaasBillingStatsProvider(saasBillingStatsProvider);
  setPlatformBrandProvider(platformBrandName);
}
