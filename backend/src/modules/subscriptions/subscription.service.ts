import { Op } from 'sequelize';
import type { PlanLimits } from '@erp/shared';
import { Plan, Subscription } from './models';
import { AppError, LimitExceeded } from '../../shared/errors';

export const UNLIMITED: PlanLimits = {
  maxStudents: null,
  maxBranches: null,
  maxTeachers: null,
  storageMb: null,
  aiTokensMonthly: null,
  enabledModules: null,
};

export async function getActiveSubscription(instituteId: number) {
  const now = new Date();
  return Subscription.findOne({
    where: {
      instituteId,
      status: { [Op.in]: ['trial', 'active', 'past_due'] },
      startsAt: { [Op.lte]: now },
      [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: now } }],
    },
    include: [{ model: Plan, as: 'plan' }],
    order: [['startsAt', 'DESC']],
  });
}

/** Effective plan limits (plan + per-institute overrides). Throws if there is no active subscription. */
export async function getPlanLimits(instituteId: number): Promise<PlanLimits> {
  const sub = await getActiveSubscription(instituteId);
  if (!sub?.plan) throw new AppError(402, 'SUBSCRIPTION_INACTIVE', 'The institute has no active subscription');
  return { ...UNLIMITED, ...sub.plan.limits, ...(sub.limitOverrides ?? {}) };
}

type NumericLimit = 'maxStudents' | 'maxBranches' | 'maxTeachers' | 'storageMb' | 'aiTokensMonthly';

/** Throws PLAN_LIMIT_EXCEEDED when `current + adding` would exceed the plan limit. */
export async function assertWithinLimit(instituteId: number, limit: NumericLimit, current: number, adding = 1) {
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
