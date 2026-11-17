import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Op, fn, col } from 'sequelize';
import { z } from 'zod';
import { SYSTEM_ROLES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireSuperAdmin } from '../../shared/middleware/authorize';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Institute } from './institute.model';
import { Branch } from '../branches/branch.model';
import { User } from '../users/user.model';
import { UserRole } from '../permissions/models';
import { getSystemRole } from '../permissions/catalog.service';
import { Plan, Subscription } from '../subscriptions/models';

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB')
  .nullable()
  .optional();
const profile = z.object({
  name: z.string().trim().min(2).max(150),
  primaryColor: color,
  secondaryColor: color,
  address: z.string().max(1000).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  state: z.string().max(80).nullable().optional(),
  registrationNumber: z.string().max(80).nullable().optional(),
  gstin: z.string().max(20).nullable().optional(),
  contactEmail: z.string().email().nullable().optional(),
  contactPhone: z.string().max(20).nullable().optional(),
});

const createSchema = profile.extend({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{3,60}$/, 'Lowercase letters, digits and dashes'),
  planId: z.number().int().positive(),
  admin: z.object({
    name: z.string().trim().min(2).max(150),
    mobile: z
      .string()
      .trim()
      .regex(/^\+?\d{10,15}$/),
    email: z.string().email().optional(),
    password: z.string().min(8).max(200).optional(),
  }),
});

export function instituteAdminRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireSuperAdmin);

  r.get('/dashboard', async (_req, res) => {
    const byStatus = await Institute.findAll({
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      group: ['status'],
      raw: true,
    });
    const [users, branches] = await Promise.all([
      User.count(),
      Branch.count({ tenantBypass: true } as object),
    ]);
    res.json({ institutesByStatus: byStatus, users, branches });
  });

  r.get('/institutes', async (req, res) => {
    const q = parse(
      paginationSchema.extend({ status: z.enum(['active', 'inactive', 'suspended']).optional() }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.search)
      where[Op.or] = [{ name: { [Op.like]: `%${q.search}%` } }, { slug: { [Op.like]: `%${q.search}%` } }];
    const { rows, count } = await Institute.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      ...toLimitOffset(q),
    });
    const subs = await Subscription.findAll({
      where: { instituteId: rows.map((i) => i.id), status: { [Op.in]: ['trial', 'active', 'past_due'] } },
      include: [{ model: Plan, as: 'plan', attributes: ['id', 'name', 'code'] }],
    });
    res.json(
      paginated(
        rows.map((i) => ({
          ...i.toJSON(),
          branding: i.toBranding(),
          subscription: subs.find((s) => s.instituteId === i.id) ?? null,
        })),
        count,
        q,
      ),
    );
  });

  r.get('/institutes/:id', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const inst = await Institute.findByPk(id);
    if (!inst) throw NotFound('Institute');
    const [branches, subscriptions] = await Promise.all([
      Branch.findAll({ where: { instituteId: id } }),
      Subscription.findAll({
        where: { instituteId: id },
        include: [{ model: Plan, as: 'plan' }],
        order: [['startsAt', 'DESC']],
      }),
    ]);
    res.json({ ...inst.toJSON(), branding: inst.toBranding(), branches, subscriptions });
  });

  r.post('/institutes', async (req, res) => {
    const body = parse(createSchema, req.body);
    const plan = await Plan.findByPk(body.planId);
    if (!plan) throw BadRequest('Unknown plan');
    if (await Institute.findOne({ where: { slug: body.slug } }))
      throw Conflict('Slug already in use', 'SLUG_TAKEN');
    const adminRole = await getSystemRole(SYSTEM_ROLES.INSTITUTE_ADMIN);

    const institute = await getSequelize().transaction(async (transaction) => {
      const { admin, planId: _p, ...data } = body;
      const inst = await Institute.create(
        { ...nullify(data), slug: body.slug, logoFileId: null, bankDetails: null },
        { transaction },
      );
      await Branch.create(
        {
          instituteId: inst.id,
          name: 'Main Branch',
          code: 'MAIN',
          address: null,
          city: data.city ?? null,
          phone: null,
          email: null,
        },
        { transaction },
      );
      await Subscription.create(
        {
          instituteId: inst.id,
          planId: plan.id,
          status: plan.trialDays > 0 ? 'trial' : 'active',
          billingCycle: 'monthly',
          startsAt: new Date(),
          endsAt: plan.trialDays > 0 ? new Date(Date.now() + plan.trialDays * 86400_000) : null,
          limitOverrides: null,
        },
        { transaction },
      );
      let user = await User.findOne({ where: { mobile: admin.mobile }, transaction });
      if (!user) {
        user = await User.create(
          {
            name: admin.name,
            mobile: admin.mobile,
            email: admin.email ?? null,
            passwordHash: admin.password ? await bcrypt.hash(admin.password, 10) : null,
            lastLoginAt: null,
          },
          { transaction },
        );
      }
      await UserRole.create(
        { userId: user.id, roleId: adminRole.id, instituteId: inst.id, branchId: null },
        { transaction },
      );
      return inst;
    });
    await audit({
      action: 'institute.created',
      entityType: 'institute',
      entityId: institute.id,
      instituteId: institute.id,
      metadata: { planId: plan.id },
    });
    res.status(201).json(institute);
  });

  r.patch('/institutes/:id', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(profile.partial(), req.body);
    const inst = await Institute.findByPk(id);
    if (!inst) throw NotFound('Institute');
    await inst.update(nullify(body));
    await audit({
      action: 'institute.updated',
      entityType: 'institute',
      entityId: id,
      instituteId: id,
      metadata: { fields: Object.keys(body) },
    });
    res.json(inst);
  });

  r.post('/institutes/:id/status', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        status: z.enum(['active', 'inactive', 'suspended']),
        reason: z.string().max(255).optional(),
      }),
      req.body,
    );
    const inst = await Institute.findByPk(id);
    if (!inst) throw NotFound('Institute');
    const previous = inst.status;
    await inst.update({ status: body.status });
    await audit({
      action: `institute.status_changed`,
      entityType: 'institute',
      entityId: id,
      instituteId: id,
      metadata: { from: previous, to: body.status, reason: body.reason },
    });
    res.json(inst);
  });

  r.get('/institutes/:id/admins', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const rows = await UserRole.findAll({
      where: { instituteId: id },
      include: [{ model: User, as: 'user' }],
    });
    const seen = new Map<number, ReturnType<User['toPublic']>>();
    rows.forEach((r) => r.user && seen.set(r.userId, r.user.toPublic()));
    res.json([...seen.values()]);
  });

  api.use('/admin', r);
}

function nullify<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? null : v])) as T;
}
