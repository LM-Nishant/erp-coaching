import { Op, QueryTypes } from 'sequelize';
import type { AdminSubscriptionRowDto, SubscriptionAccessState, UsageSnapshotDto } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Institute } from '../institutes/institute.model';
import { Plan, Subscription, SubscriptionUsage } from './models';
import { getBillingPolicy } from './billing-settings';
import { platform } from './invoices.service';
import { toSubscriptionDto } from './lifecycle.service';
import { computeAccessState, CURRENT_STATUSES } from './subscription.service';

export interface AdminSubscriptionQuery {
  search?: string;
  state?: SubscriptionAccessState;
  planId?: number;
  page: number;
  pageSize: number;
}

/** Super admin: every institute with its current subscription, access state and unpaid balance. */
export async function listAdminSubscriptions(q: AdminSubscriptionQuery, now = new Date()) {
  const institutes = await Institute.findAll({
    attributes: ['id', 'name', 'slug', 'status'],
    where: q.search
      ? { [Op.or]: [{ name: { [Op.like]: `%${q.search}%` } }, { slug: { [Op.like]: `%${q.search}%` } }] }
      : {},
    order: [['name', 'ASC']],
  });
  const ids = institutes.map((i) => i.id);
  const [subs, plans, balances, policy] = await Promise.all([
    ids.length
      ? Subscription.findAll(
          platform({
            where: {
              instituteId: { [Op.in]: ids },
              status: { [Op.in]: CURRENT_STATUSES },
              startsAt: { [Op.lte]: now },
            },
            order: [
              ['startsAt', 'DESC'],
              ['id', 'DESC'],
            ] as [string, string][],
          }),
        )
      : [],
    Plan.findAll(),
    getSequelize().query<{ institute_id: number; balance: string | number }>(
      `SELECT institute_id, SUM(total_paise - credited_paise - paid_paise) AS balance
         FROM subscription_invoices WHERE status = 'open' AND institute_id IS NOT NULL GROUP BY institute_id`,
      { type: QueryTypes.SELECT },
    ),
    getBillingPolicy(),
  ]);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const current = new Map<number, Subscription>();
  for (const s of subs) {
    if (current.has(s.instituteId)) continue;
    s.plan = planById.get(s.planId);
    s.pendingPlan = s.pendingPlanId ? (planById.get(s.pendingPlanId) ?? null) : null;
    current.set(s.instituteId, s);
  }
  const balanceOf = new Map(balances.map((b) => [Number(b.institute_id), Number(b.balance) || 0]));
  const rows: AdminSubscriptionRowDto[] = institutes.map((i) => {
    const sub = current.get(i.id) ?? null;
    const access = computeAccessState(sub, policy, now);
    return {
      instituteId: i.id,
      instituteName: i.name,
      instituteSlug: i.slug,
      instituteStatus: i.status,
      subscription: sub ? toSubscriptionDto(sub) : null,
      state: access.state,
      graceEndsAt: access.graceEndsAt?.toISOString() ?? null,
      openBalancePaise: balanceOf.get(i.id) ?? 0,
    };
  });
  const filtered = rows.filter(
    (r) => (!q.state || r.state === q.state) && (!q.planId || r.subscription?.planId === q.planId),
  );
  const offset = (q.page - 1) * q.pageSize;
  return {
    items: filtered.slice(offset, offset + q.pageSize),
    total: filtered.length,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** Daily usage snapshots of an institute (oldest first). */
export async function usageSnapshots(
  instituteId: number,
  from: string,
  to: string,
): Promise<UsageSnapshotDto[]> {
  const rows = await SubscriptionUsage.findAll({
    where: { instituteId, snapshotDate: { [Op.between]: [from, to] } },
    order: [['snapshotDate', 'ASC']],
  });
  return rows.map((r) => ({
    snapshotDate: String(r.snapshotDate).slice(0, 10),
    students: r.students,
    branches: r.branches,
    teachers: r.teachers,
    storageMb: r.storageMb,
    aiTokensMonth: r.aiTokensMonth,
  }));
}
