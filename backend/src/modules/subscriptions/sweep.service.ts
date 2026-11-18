import { Op } from 'sequelize';
import { METRIC_LABELS, type BillingPolicyDto } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Job } from '../../infrastructure/jobs/job.model';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { runWithContext } from '../../shared/context';
import { Institute } from '../institutes/institute.model';
import { Subscription, type SubscriptionInvoice } from './models';
import { getBillingPolicy } from './billing-settings';
import { createInvoice, platform } from './invoices.service';
import { issueDueRenewal, monthLabel } from './lifecycle.service';
import {
  CURRENT_STATUSES,
  computeAccessState,
  getCurrentSubscription,
  invalidateAccess,
} from './subscription.service';
import { computeOverage, snapshotUsage } from './usage.service';
import { notifyInstituteAdmins } from './notifications';
import { DAY_MS, formatDay, formatRupees, isoDay, nextMonth, startOfMonth } from './util';

export const BILLING_SWEEP_JOB = 'subscriptions.billing-sweep';
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Trial-ending reminder lead time when the policy issues renewals later than this. */
const TRIAL_NOTICE_DAYS = 3;

export interface BillingSweepResult {
  institutes: number;
  renewalInvoices: number;
  overageInvoices: number;
  notices: number;
  failures: number;
}

async function notifyInvoice(inv: SubscriptionInvoice) {
  if (!inv.instituteId) return;
  await notifyInstituteAdmins(inv.instituteId, 'subscriptions.invoice-issued', {
    invoiceNo: inv.number,
    amount: formatRupees(inv.totalPaise),
    dueDate: inv.dueDate,
  });
}

/** Keeps the stored status in step with the dates (the access state itself is computed). */
async function syncStatus(sub: Subscription, graceEndsAt: Date | null, now: Date) {
  if (!sub.endsAt || sub.status === 'trial' || sub.endsAt > now) return;
  const status = graceEndsAt && now >= graceEndsAt ? 'expired' : 'past_due';
  if (sub.status === status || (sub.status === 'expired' && status === 'past_due')) return;
  await Subscription.update({ status }, { where: { instituteId: sub.instituteId, id: sub.id } });
  sub.status = status;
  invalidateAccess(sub.instituteId);
}

/** One notice per state and term: the key is remembered in `lastNotice`. */
async function sendStateNotice(sub: Subscription, policy: BillingPolicyDto, now: Date): Promise<boolean> {
  const access = computeAccessState(sub, policy, now);
  const plan = sub.plan?.name ?? 'subscription';
  const term = sub.endsAt ? isoDay(sub.endsAt) : 'open';
  let notice: { key: string; event: string; data: Record<string, unknown> } | null = null;
  if (access.state === 'trial' && sub.endsAt) {
    const lead = Math.max(policy.renewalLeadDays, TRIAL_NOTICE_DAYS) * DAY_MS;
    if (sub.endsAt.getTime() - now.getTime() <= lead)
      notice = {
        key: `trial_ending:${term}`,
        event: 'subscriptions.trial-ending',
        data: { plan, endsAt: formatDay(sub.endsAt) },
      };
  } else if (access.state === 'grace' && sub.endsAt && access.graceEndsAt)
    notice = {
      key: `expired:${term}`,
      event: 'subscriptions.expired',
      data: { plan, endsAt: formatDay(sub.endsAt), graceEndsAt: formatDay(access.graceEndsAt) },
    };
  else if (access.state === 'restricted')
    notice = {
      key: `restricted:${term}`,
      event: 'subscriptions.restricted',
      data: { plan, suspendsAt: access.suspendsAt ? formatDay(access.suspendsAt) : '' },
    };
  else if (access.state === 'suspended')
    notice = {
      key: `suspended:${sub.suspendedAt ? isoDay(sub.suspendedAt) : term}`,
      event: 'subscriptions.suspended',
      data: {
        message: sub.suspendedAt
          ? `Your account has been suspended${sub.suspendReason ? `: ${sub.suspendReason}` : ''}. Contact support to restore access.`
          : 'Your subscription has lapsed and the account is suspended. Renew from Subscription & billing to restore access.',
      },
    };
  if (!notice || sub.lastNotice === notice.key) return false;
  await Subscription.update(
    { lastNotice: notice.key },
    { where: { instituteId: sub.instituteId, id: sub.id } },
  );
  sub.lastNotice = notice.key;
  await notifyInstituteAdmins(sub.instituteId, notice.event, notice.data);
  return true;
}

const lastDayOf = (month: Date) => isoDay(new Date(nextMonth(month).getTime() - DAY_MS));

/**
 * Bills usage above the included limits for each completed month (soft limits priced by the
 * plan). `overageBilledThrough` (last billed day) starts at the end of the month before the first
 * sweep, so earlier months are never billed retroactively.
 */
async function billOverage(instituteId: number, now: Date): Promise<SubscriptionInvoice[]> {
  const current = startOfMonth(now);
  const issued: SubscriptionInvoice[] = [];
  await getSequelize().transaction(async (transaction) => {
    const sub = await getCurrentSubscription(instituteId, { transaction, lock: true });
    if (!sub?.plan) return;
    if (!sub.overageBilledThrough) {
      const through = lastDayOf(new Date(current.getTime() - DAY_MS));
      await Subscription.update(
        { overageBilledThrough: through },
        { where: { instituteId, id: sub.id }, transaction },
      );
      return;
    }
    let month = startOfMonth(new Date(new Date(`${sub.overageBilledThrough}T00:00:00Z`).getTime() + DAY_MS));
    while (nextMonth(month) <= current) {
      const lines = await computeOverage(sub, sub.plan, month);
      if (lines.length)
        issued.push(
          await createInvoice(
            {
              instituteId,
              subscriptionId: sub.id,
              kind: 'overage',
              lines: lines.map((l) => ({
                description: `${METRIC_LABELS[l.metric]} above the included ${l.included}, ${monthLabel(month)} (${l.over} over)`,
                quantity: l.units,
                unitPricePaise: l.unitPricePaise,
                amountPaise: l.amountPaise,
                itemType: `overage:${l.metric}`,
              })),
              periodStart: month,
              periodEnd: nextMonth(month),
              meta: { action: 'overage', month: isoDay(month) },
              now,
            },
            transaction,
          ),
        );
      await Subscription.update(
        { overageBilledThrough: lastDayOf(month) },
        { where: { instituteId, id: sub.id }, transaction },
      );
      month = nextMonth(month);
    }
  });
  return issued;
}

/** One institute's billing housekeeping; each step is independent of the others' failures. */
export async function sweepInstitute(
  instituteId: number,
  policy: BillingPolicyDto,
  now: Date,
  result: BillingSweepResult,
): Promise<void> {
  const sub = await getCurrentSubscription(instituteId);
  if (!sub) return;
  const institute = await Institute.findByPk(instituteId, { attributes: ['id', 'status'] });
  if (!institute) return;
  const steps: [string, () => Promise<void>][] = [
    ['status', () => syncStatus(sub, computeAccessState(sub, policy, now).graceEndsAt, now)],
    [
      'renewal',
      async () => {
        if (institute.status !== 'active') return;
        const inv = await issueDueRenewal(sub, policy.renewalLeadDays, now);
        if (inv) {
          result.renewalInvoices++;
          await notifyInvoice(inv);
        }
      },
    ],
    [
      'notice',
      async () => {
        if (institute.status === 'active' && (await sendStateNotice(sub, policy, now))) result.notices++;
      },
    ],
    ['snapshot', async () => void (await snapshotUsage(instituteId, now))],
    [
      'overage',
      async () => {
        for (const inv of await billOverage(instituteId, now)) {
          result.overageInvoices++;
          await notifyInvoice(inv);
        }
      },
    ],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (err) {
      result.failures++;
      logger.error({ err, instituteId, step }, 'Billing sweep step failed');
    }
  }
}

/** Hourly across all institutes with a current subscription. */
export async function runBillingSweep(now = new Date()): Promise<BillingSweepResult> {
  const result: BillingSweepResult = {
    institutes: 0,
    renewalInvoices: 0,
    overageInvoices: 0,
    notices: 0,
    failures: 0,
  };
  const policy = await getBillingPolicy();
  const rows = await Subscription.findAll(
    platform({
      where: { status: { [Op.in]: CURRENT_STATUSES }, startsAt: { [Op.lte]: now } },
      attributes: ['instituteId'],
      group: ['instituteId'],
    }),
  );
  for (const { instituteId } of rows) {
    result.institutes++;
    await runWithContext({ system: true, instituteId, allowedBranchIds: null }, () =>
      sweepInstitute(instituteId, policy, now, result),
    );
  }
  if (result.failures) logger.warn({ ...result }, 'Billing sweep finished with failures');
  return result;
}

export async function scheduleBillingSweep(): Promise<void> {
  const pending = await Job.findOne({ where: { name: BILLING_SWEEP_JOB, status: 'pending' } });
  if (pending) return;
  await enqueueJob(
    BILLING_SWEEP_JOB,
    {},
    { instituteId: null, runAt: new Date(Date.now() + SWEEP_INTERVAL_MS) },
  );
}

export async function billingSweepJob(): Promise<void> {
  try {
    await runBillingSweep();
  } finally {
    await scheduleBillingSweep();
  }
}
