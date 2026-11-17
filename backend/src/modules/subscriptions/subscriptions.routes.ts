import { Router } from 'express';
import { Op, fn, col } from 'sequelize';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { idParam } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { NotFound, BadRequest } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { Institute } from '../institutes/institute.model';
import { Branch } from '../branches/branch.model';
import { FileObject } from '../files/file.model';
import { AiUsage } from '../ai/models';
import { Plan, Subscription } from './models';
import { getActiveSubscription, getPlanLimits } from './subscription.service';

const limitsSchema = z.object({
  maxStudents: z.number().int().min(0).nullable(),
  maxBranches: z.number().int().min(0).nullable(),
  maxTeachers: z.number().int().min(0).nullable(),
  storageMb: z.number().int().min(0).nullable(),
  aiTokensMonthly: z.number().int().min(0).nullable(),
  enabledModules: z.array(z.string()).nullable(),
});

const planSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().max(255).nullable().optional(),
  priceMonthlyPaise: z.number().int().min(0),
  priceYearlyPaise: z.number().int().min(0),
  trialDays: z.number().int().min(0).max(365).default(14),
  limits: limitsSchema,
  isActive: z.boolean().default(true),
});

export function startOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function usageFor(instituteId: number) {
  const [branches, storageBytes, aiTokens] = await Promise.all([
    Branch.count({ where: { instituteId, status: 'active' } }),
    FileObject.sum('sizeBytes', { where: { instituteId } }),
    AiUsage.sum('totalTokens', { where: { instituteId, createdAt: { [Op.gte]: startOfMonth() } } }),
  ]);
  return { branches, storageMb: Math.round(((storageBytes || 0) / 1048576) * 100) / 100, aiTokensThisMonth: aiTokens || 0 };
}

export function subscriptionRoutes(api: Router) {
  // ---- Super admin: plans & subscriptions
  const admin = Router();
  admin.use(authenticate, requireSuperAdmin);

  admin.get('/plans', async (_req, res) => {
    const plans = await Plan.findAll({ order: [['priceMonthlyPaise', 'ASC']] });
    const counts = await Subscription.findAll({
      attributes: ['planId', [fn('COUNT', col('id')), 'count']],
      where: { status: { [Op.in]: ['trial', 'active', 'past_due'] } },
      group: ['planId'],
      raw: true,
      tenantBypass: true,
    } as object);
    res.json(plans.map((p) => ({ ...p.toJSON(), activeSubscriptions: Number((counts as unknown as { planId: number; count: number }[]).find((c) => c.planId === p.id)?.count ?? 0) })));
  });

  admin.post('/plans', async (req, res) => {
    const body = parse(planSchema, req.body);
    const plan = await Plan.create({ ...body, description: body.description ?? null });
    await audit({ action: 'plan.created', entityType: 'plan', entityId: plan.id, instituteId: null });
    res.status(201).json(plan);
  });

  admin.put('/plans/:id', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(planSchema, req.body);
    const plan = await Plan.findByPk(id);
    if (!plan) throw NotFound('Plan');
    const before = plan.toJSON();
    await plan.update({ ...body, description: body.description ?? null });
    await audit({ action: 'plan.updated', entityType: 'plan', entityId: id, instituteId: null, metadata: { before: before.limits, after: body.limits } });
    res.json(plan);
  });

  admin.post('/institutes/:id/subscriptions', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        planId: z.number().int().positive(),
        status: z.enum(['trial', 'active']),
        billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
        endsAt: z.coerce.date().nullable().optional(),
        limitOverrides: limitsSchema.partial().nullable().optional(),
      }),
      req.body,
    );
    if (!(await Institute.findByPk(id))) throw NotFound('Institute');
    if (!(await Plan.findByPk(body.planId))) throw BadRequest('Unknown plan');
    await Subscription.update(
      { status: 'cancelled', endsAt: new Date() },
      { where: { instituteId: id, status: { [Op.in]: ['trial', 'active', 'past_due'] } } },
    );
    const sub = await Subscription.create({
      instituteId: id,
      planId: body.planId,
      status: body.status,
      billingCycle: body.billingCycle,
      startsAt: new Date(),
      endsAt: body.endsAt ?? null,
      limitOverrides: body.limitOverrides ?? null,
    });
    await audit({ action: 'subscription.changed', entityType: 'subscription', entityId: sub.id, instituteId: id, metadata: body });
    res.status(201).json(sub);
  });

  admin.get('/institutes/:id/usage', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ usage: await usageFor(id), limits: await getPlanLimits(id).catch(() => null) });
  });

  api.use('/admin', admin);

  // ---- Institute: current plan & usage
  api.get('/subscription', authenticate, requirePermission('subscription', 'view'), async (_req, res) => {
    const { instituteId } = requireTenantContext();
    const sub = await getActiveSubscription(instituteId);
    res.json({
      subscription: sub,
      limits: sub ? await getPlanLimits(instituteId) : null,
      usage: await usageFor(instituteId),
    });
  });
}
