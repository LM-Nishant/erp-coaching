import express, { Router, type Request, type Response } from 'express';
import { Op, col, fn } from 'sequelize';
import { z } from 'zod';
import {
  ADDON_KINDS,
  CHECKOUT_PLATFORMS,
  METERED_METRICS,
  PLAN_MODULE_KEYS,
  type SubscriptionAccessState,
} from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin, requireTenant } from '../../shared/middleware/authorize';
import { getContext, hasPermission, requireTenantContext } from '../../shared/context';
import { BadRequest, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { webhookRateLimit } from '../../shared/middleware/security';
import { sendCheckoutReturn, verifyCheckoutReturn } from '../../shared/utilities/checkout-return';
import { logger } from '../../infrastructure/logger';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Institute } from '../institutes/institute.model';
import { User } from '../users/user.model';
import { Plan, Subscription, SubscriptionCreditNote } from './models';
import {
  getAccessState,
  getActiveSubscription,
  getCurrentSubscription,
  getPlanLimits,
  invalidateAccess,
} from './subscription.service';
import { usageFor } from './usage.service';
import {
  billingOverview,
  assignSubscription,
  cancelAddon,
  cancelPendingChange,
  changePlan,
  extendTrial,
  previewPlanChange,
  purchaseAddon,
  reactivateSubscription,
  requestRenewal,
  suspendSubscription,
  toPlanDto,
  toStatusDto,
  toSubscriptionDto,
  toAddonDto,
} from './lifecycle.service';
import {
  createInvoice,
  findInvoice,
  listCreditNotes,
  listInvoices,
  toInvoiceDto,
  voidInvoice,
} from './invoices.service';
import {
  completeMockCheckout,
  creditInvoice,
  invoiceDetail,
  listPayments,
  processWebhook,
  recordManualPayment,
  startCheckout,
  syncPayment,
  syncReturnedSaasPayment,
} from './payments.service';
import {
  getBillingPolicy,
  getBillingProfile,
  saveBillingPolicy,
  saveBillingProfile,
} from './billing-settings';
import { listAdminSubscriptions, usageSnapshots } from './admin.service';
import { renderSignedDocument, signDocumentToken } from './documents';
import { runBillingSweep } from './sweep.service';
import { usageSummary } from './api';
import { addDaysIso, billingDate } from './util';

// ------------------------------------------------------------------ schemas

const limitsSchema = z.object({
  maxStudents: z.number().int().min(0).nullable(),
  maxBranches: z.number().int().min(0).nullable(),
  maxTeachers: z.number().int().min(0).nullable(),
  storageMb: z.number().int().min(0).nullable(),
  aiTokensMonthly: z.number().int().min(0).nullable(),
  enabledModules: z
    .array(z.enum(PLAN_MODULE_KEYS))
    .max(PLAN_MODULE_KEYS.length)
    .transform((keys) => [...new Set(keys)])
    .nullable(),
});

const moduleKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{2,40}$/);

const addonSchema = z
  .object({
    kind: z.enum(ADDON_KINDS),
    unitSize: z.number().int().min(1).max(1_000_000_000),
    monthlyPricePaise: z.number().int().min(0),
    yearlyPricePaise: z.number().int().min(0).default(0),
    moduleKey: moduleKey.nullable().optional(),
  })
  .refine((a) => a.kind !== 'module' || !!a.moduleKey, {
    message: 'A module add-on needs the module key',
    path: ['moduleKey'],
  })
  .transform((a) => ({
    ...a,
    unitSize: a.kind === 'module' ? 1 : a.unitSize,
    moduleKey: a.kind === 'module' ? (a.moduleKey ?? null) : null,
  }));

const overageSchema = z.object({
  unitSize: z.number().int().min(1).max(1_000_000_000),
  pricePaise: z.number().int().min(0),
  maxOverage: z.number().int().min(0).nullable().optional(),
});

const usagePricingSchema = z.object(
  Object.fromEntries(METERED_METRICS.map((m) => [m, overageSchema.optional()])) as Record<
    (typeof METERED_METRICS)[number],
    z.ZodOptional<typeof overageSchema>
  >,
);

const planSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().max(255).nullable().optional(),
  priceMonthlyPaise: z.number().int().min(0),
  priceYearlyPaise: z.number().int().min(0),
  trialDays: z.number().int().min(0).max(365).default(14),
  limits: limitsSchema,
  isActive: z.boolean().default(true),
  addons: z
    .array(addonSchema)
    .max(30)
    .refine((list) => new Set(list.map((a) => `${a.kind}:${a.moduleKey ?? ''}`)).size === list.length, {
      message: 'Each add-on kind (and module) may be listed once',
    })
    .optional(),
  usagePricing: usagePricingSchema.optional(),
});

const cycle = z.enum(['monthly', 'yearly']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATES = [
  'none',
  'trial',
  'active',
  'grace',
  'restricted',
  'suspended',
] as const satisfies readonly SubscriptionAccessState[];

const invoiceQuery = paginationSchema.extend({
  status: z.enum(['open', 'paid', 'void']).optional(),
  kind: z.enum(['subscription', 'renewal', 'upgrade', 'addon', 'overage', 'manual']).optional(),
  instituteId: z.coerce.number().int().positive().optional(),
});
const paymentQuery = paginationSchema.extend({
  instituteId: z.coerce.number().int().positive().optional(),
  invoiceId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'success', 'failed']).optional(),
  method: z.enum(['gateway', 'manual']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
const rangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const reasonSchema = z.string().trim().min(3).max(255);

const userId = () => getContext().userId ?? null;

function snapshotRange(q: { from?: string; to?: string }) {
  const to = q.to ?? billingDate();
  const from = q.from ?? addDaysIso(to, -30);
  if (from > to) throw BadRequest('`from` must not be after `to`');
  return { from, to };
}

async function requireInstitute(id: number) {
  const institute = await Institute.findByPk(id);
  if (!institute) throw NotFound('Institute');
  return institute;
}

// ------------------------------------------------------------------ institute

function tenantRoutes(api: Router) {
  const r = Router();
  r.use(authenticate);
  const can = (action: 'view' | 'edit') => requirePermission('subscription', action);

  // Dashboard card (kept for existing callers).
  r.get('/', can('view'), async (_req, res) => {
    const { instituteId } = requireTenantContext();
    const sub = await getActiveSubscription(instituteId);
    res.json({
      subscription: sub,
      limits: sub ? await getPlanLimits(instituteId) : null,
      usage: await usageFor(instituteId),
    });
  });

  // Banner state for every member (no permission needed).
  r.get('/status', requireTenant, async (_req, res) => {
    const { instituteId } = requireTenantContext();
    const [access, policy] = await Promise.all([getAccessState(instituteId), getBillingPolicy()]);
    res.json(toStatusDto(access, hasPermission('subscription.edit'), policy.renewalLeadDays));
  });

  r.get('/overview', can('view'), async (_req, res) => {
    const { instituteId } = requireTenantContext();
    res.json(await billingOverview(instituteId, hasPermission('subscription.edit')));
  });

  r.get('/usage/snapshots', can('view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const { from, to } = snapshotRange(parse(rangeQuery, req.query));
    res.json(await usageSnapshots(instituteId, from, to));
  });

  r.get('/invoices', can('view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const q = parse(invoiceQuery.omit({ instituteId: true }), req.query);
    res.json(await listInvoices({ ...q, instituteId }, true));
  });

  r.get('/invoices/:id', can('view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    res.json(await invoiceDetail(parse(idParam, req.params).id, instituteId));
  });

  r.get('/invoices/:id/pdf', can('view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const inv = await findInvoice(parse(idParam, req.params).id, instituteId);
    res.json(signDocumentToken('inv', inv.id, instituteId));
  });

  r.get('/credit-notes', can('view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const q = parse(paginationSchema, req.query);
    res.json(await listCreditNotes({ ...q, instituteId }, true));
  });

  r.get('/credit-notes/:id/pdf', can('view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const { id } = parse(idParam, req.params);
    const note = await SubscriptionCreditNote.findOne({ where: { instituteId, id } });
    if (!note) throw NotFound('Credit note');
    res.json(signDocumentToken('cn', note.id, instituteId));
  });

  r.get('/payments', can('view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const q = parse(paymentQuery.omit({ instituteId: true }), req.query);
    res.json(await listPayments({ ...q, instituteId }, true));
  });

  r.post('/invoices/:id/checkout', can('edit'), async (req, res) => {
    const { instituteId, userId: uid } = requireTenantContext();
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        idempotencyKey: z.string().trim().min(8).max(100).optional(),
        returnTo: z
          .object({ platform: z.enum(CHECKOUT_PLATFORMS), path: z.string().max(80).optional() })
          .nullable()
          .optional(),
      }),
      req.body ?? {},
    );
    const user = await User.findByPk(uid!);
    if (!user) throw NotFound('User');
    const result = await startCheckout(instituteId, id, {
      idempotencyKey: req.header('idempotency-key') ?? body.idempotencyKey ?? null,
      userId: user.id,
      customer: { name: user.name, mobile: user.mobile, ...(user.email ? { email: user.email } : {}) },
      returnTo: body.returnTo,
    });
    res.status(201).json(result);
  });

  // Development/test: completes a mock gateway checkout (404 in production).
  r.post('/payments/:id/mock-complete', can('edit'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const { id } = parse(idParam, req.params);
    const { outcome } = parse(
      z.object({ outcome: z.enum(['success', 'failed']).default('success') }),
      req.body ?? {},
    );
    res.json(await completeMockCheckout(instituteId, id, outcome));
  });

  r.post('/payments/:id/sync', can('edit'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    res.json(await syncPayment(instituteId, parse(idParam, req.params).id));
  });

  r.post('/renew', can('edit'), async (_req, res) => {
    const { instituteId } = requireTenantContext();
    res.json(await requestRenewal(instituteId, userId()));
  });

  const planChangeSchema = z.object({ planId: z.number().int().positive(), billingCycle: cycle });
  r.post('/plan-change/preview', can('view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const body = parse(planChangeSchema, req.body);
    res.json(await previewPlanChange(instituteId, body.planId, body.billingCycle));
  });

  r.post('/plan-change', can('edit'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const body = parse(planChangeSchema, req.body);
    res.json(await changePlan(instituteId, body.planId, body.billingCycle, userId()));
  });

  r.delete('/plan-change', can('edit'), async (_req, res) => {
    const { instituteId } = requireTenantContext();
    await cancelPendingChange(instituteId);
    res.status(204).end();
  });

  r.post('/addons', can('edit'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    const body = parse(
      z.object({
        kind: z.enum(ADDON_KINDS),
        moduleKey: moduleKey.nullable().optional(),
        quantity: z.number().int().min(1).max(1000).default(1),
      }),
      req.body,
    );
    res.status(201).json(await purchaseAddon(instituteId, body, userId()));
  });

  r.post('/addons/:id/cancel', can('edit'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    res.json(toAddonDto(await cancelAddon(instituteId, parse(idParam, req.params).id)));
  });

  api.use('/subscription', r);
}

// ------------------------------------------------------------------ super admin

function adminRoutes(api: Router) {
  const a = Router();
  a.use(authenticate, requireSuperAdmin);

  a.get('/plans', async (_req, res) => {
    const plans = await Plan.findAll({ order: [['priceMonthlyPaise', 'ASC']] });
    const counts = (await Subscription.findAll({
      attributes: ['planId', [fn('COUNT', col('id')), 'count']],
      where: { status: { [Op.in]: ['trial', 'active', 'past_due'] } },
      group: ['planId'],
      raw: true,
      tenantBypass: true,
    } as object)) as unknown as { planId: number; count: number }[];
    res.json(plans.map((p) => toPlanDto(p, Number(counts.find((c) => c.planId === p.id)?.count ?? 0))));
  });

  a.post('/plans', async (req, res) => {
    const body = parse(planSchema, req.body);
    const plan = await Plan.create({
      ...body,
      description: body.description ?? null,
      addons: body.addons ?? null,
      usagePricing: body.usagePricing ?? null,
    });
    await audit({ action: 'plan.created', entityType: 'plan', entityId: plan.id, instituteId: null });
    res.status(201).json(toPlanDto(plan));
  });

  a.put('/plans/:id', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(planSchema, req.body);
    const plan = await Plan.findByPk(id);
    if (!plan) throw NotFound('Plan');
    const before = toPlanDto(plan);
    // Omitted add-ons / usage pricing keep their current values.
    await plan.update({
      ...body,
      description: body.description ?? null,
      addons: body.addons === undefined ? plan.addons : body.addons,
      usagePricing: body.usagePricing === undefined ? plan.usagePricing : body.usagePricing,
    });
    await audit({
      action: 'plan.updated',
      entityType: 'plan',
      entityId: id,
      instituteId: null,
      metadata: {
        before: { limits: before.limits, addons: before.addons, usagePricing: before.usagePricing },
        after: { limits: body.limits, addons: body.addons, usagePricing: body.usagePricing },
      },
    });
    invalidateAccess();
    res.json(toPlanDto(plan));
  });

  // Assign / replace the institute's subscription.
  a.post('/institutes/:id/subscriptions', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        planId: z.number().int().positive(),
        status: z.enum(['trial', 'active']),
        billingCycle: cycle.default('monthly'),
        endsAt: z.coerce.date().nullable().optional(),
        limitOverrides: limitsSchema.partial().nullable().optional(),
      }),
      req.body,
    );
    await requireInstitute(id);
    if (!(await Plan.findByPk(body.planId))) throw BadRequest('Unknown plan');
    const sub = await assignSubscription(id, body);
    await audit({
      action: 'subscription.changed',
      entityType: 'subscription',
      entityId: sub.id,
      instituteId: id,
      metadata: body,
    });
    res.status(201).json(toSubscriptionDto(sub));
  });

  a.get('/institutes/:id/usage', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ usage: await usageFor(id), limits: await getPlanLimits(id).catch(() => null) });
  });

  const b = Router();

  b.get('/subscriptions', async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        state: z.enum(STATES).optional(),
        planId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    res.json(await listAdminSubscriptions(q));
  });

  b.get('/institutes/:id/overview', async (req, res) => {
    const { id } = parse(idParam, req.params);
    await requireInstitute(id);
    res.json(await billingOverview(id, true));
  });

  b.get('/institutes/:id/usage-snapshots', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { from, to } = snapshotRange(parse(rangeQuery, req.query));
    res.json(await usageSnapshots(id, from, to));
  });

  b.post('/institutes/:id/extend-trial', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { days } = parse(z.object({ days: z.number().int().min(1).max(365) }), req.body);
    await requireInstitute(id);
    res.json(toSubscriptionDto(await extendTrial(id, days)));
  });

  b.post('/institutes/:id/suspend', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    await requireInstitute(id);
    res.json(toSubscriptionDto(await suspendSubscription(id, reason)));
  });

  b.post('/institutes/:id/reactivate', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { extendDays } = parse(
      z.object({ extendDays: z.number().int().min(1).max(366).nullable().optional() }),
      req.body ?? {},
    );
    await requireInstitute(id);
    res.json(toSubscriptionDto(await reactivateSubscription(id, extendDays ?? null)));
  });

  b.post('/institutes/:id/renewal-invoice', async (req, res) => {
    const { id } = parse(idParam, req.params);
    await requireInstitute(id);
    const result = await requestRenewal(id, userId());
    await audit({
      action: 'subscription.renewal_invoice',
      entityType: 'subscription',
      instituteId: id,
      metadata: { invoiceId: result.invoice?.id ?? null },
    });
    res.json(result);
  });

  b.get('/invoices', async (req, res) => {
    res.json(await listInvoices(parse(invoiceQuery, req.query), false));
  });

  b.get('/invoices/:id', async (req, res) => {
    res.json(await invoiceDetail(parse(idParam, req.params).id, null));
  });

  b.get('/invoices/:id/pdf', async (req, res) => {
    const inv = await findInvoice(parse(idParam, req.params).id, null);
    res.json(signDocumentToken('inv', inv.id, null));
  });

  // Manual invoice (setup fees, custom work, migrated dues).
  b.post('/invoices', async (req, res) => {
    const body = parse(
      z.object({
        instituteId: z.number().int().positive(),
        lines: z
          .array(
            z.object({
              description: z.string().trim().min(2).max(255),
              quantity: z.number().int().min(1).max(100_000).default(1),
              unitPricePaise: z.number().int().min(1),
            }),
          )
          .min(1)
          .max(50),
        dueDate: isoDate.optional(),
        notes: z.string().trim().max(1000).nullable().optional(),
      }),
      req.body,
    );
    await requireInstitute(body.instituteId);
    const sub = await getCurrentSubscription(body.instituteId);
    const inv = await createInvoice({
      instituteId: body.instituteId,
      subscriptionId: sub?.id ?? null,
      kind: 'manual',
      lines: body.lines,
      dueDate: body.dueDate,
      notes: body.notes ?? null,
      meta: { action: 'manual' },
      createdBy: userId(),
    });
    await audit({
      action: 'subscription.invoice_created',
      entityType: 'subscription_invoice',
      entityId: inv.id,
      instituteId: body.instituteId,
      metadata: { number: inv.number, totalPaise: inv.totalPaise },
    });
    res.status(201).json(toInvoiceDto(inv));
  });

  b.post('/invoices/:id/void', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    const inv = await getSequelize().transaction((t) => voidInvoice(id, reason, t));
    if (inv.instituteId) invalidateAccess(inv.instituteId);
    await audit({
      action: 'subscription.invoice_voided',
      entityType: 'subscription_invoice',
      entityId: id,
      instituteId: inv.instituteId,
      metadata: { number: inv.number, reason },
    });
    res.json(toInvoiceDto(inv));
  });

  b.post('/invoices/:id/payments', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        amountPaise: z.number().int().min(1),
        reference: z.string().trim().max(100).nullable().optional(),
        note: z.string().trim().max(255).nullable().optional(),
        paidAt: z.coerce.date().nullable().optional(),
      }),
      req.body,
    );
    if (body.paidAt && body.paidAt.getTime() > Date.now() + 60_000)
      throw BadRequest('`paidAt` is in the future');
    const result = await recordManualPayment(id, body, userId());
    await audit({
      action: 'subscription.payment_recorded',
      entityType: 'subscription_payment',
      entityId: result.payment.id,
      instituteId: result.invoice.instituteId,
      metadata: {
        invoice: result.invoice.number,
        amountPaise: body.amountPaise,
        reference: body.reference ?? null,
      },
    });
    res.status(201).json(result);
  });

  b.post('/invoices/:id/credit-notes', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ amountPaise: z.number().int().min(1), reason: reasonSchema }), req.body);
    const result = await creditInvoice(id, body.amountPaise, body.reason, userId());
    await audit({
      action: 'subscription.credit_note_issued',
      entityType: 'subscription_credit_note',
      entityId: result.creditNote.id,
      instituteId: result.invoice.instituteId,
      metadata: { number: result.creditNote.number, invoice: result.invoice.number, ...body },
    });
    res.status(201).json(result);
  });

  b.get('/credit-notes', async (req, res) => {
    const q = parse(
      paginationSchema.extend({ instituteId: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    res.json(await listCreditNotes(q, false));
  });

  b.get('/credit-notes/:id/pdf', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const note = await SubscriptionCreditNote.findOne({ where: { id }, tenantBypass: true } as object);
    if (!note) throw NotFound('Credit note');
    res.json(signDocumentToken('cn', id, null));
  });

  b.get('/payments', async (req, res) => {
    res.json(await listPayments(parse(paymentQuery, req.query), false));
  });

  b.post('/payments/:id/sync', async (req, res) => {
    res.json(await syncPayment(null, parse(idParam, req.params).id));
  });

  b.get('/settings', async (_req, res) => {
    const [profile, policy] = await Promise.all([getBillingProfile(), getBillingPolicy()]);
    res.json({ profile, policy });
  });

  b.put('/settings/profile', async (req, res) => {
    const body = parse(
      z.object({
        legalName: z.string().trim().min(2).max(150),
        gstin: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Invalid GSTIN')
          .nullable(),
        address: z.string().trim().max(255).nullable(),
        city: z.string().trim().max(100).nullable(),
        state: z.string().trim().max(100).nullable(),
        pincode: z.string().trim().max(12).nullable(),
        email: z.string().trim().email().max(150).nullable(),
        phone: z.string().trim().max(20).nullable(),
        invoicePrefix: z
          .string()
          .trim()
          .regex(/^[A-Z0-9-]{2,12}$/, 'Use 2-12 capitals, digits or dashes'),
        creditNotePrefix: z
          .string()
          .trim()
          .regex(/^[A-Z0-9-]{2,12}$/, 'Use 2-12 capitals, digits or dashes'),
        sacCode: z
          .string()
          .trim()
          .regex(/^\d{4,8}$/),
        gstRatePercent: z.number().min(0).max(28),
      }),
      req.body,
    );
    if (body.invoicePrefix === body.creditNotePrefix)
      throw BadRequest('Invoices and credit notes need different prefixes');
    const profile = await saveBillingProfile(body, userId());
    await audit({
      action: 'billing.profile_updated',
      entityType: 'billing_settings',
      instituteId: null,
      metadata: body,
    });
    res.json(profile);
  });

  b.put('/settings/policy', async (req, res) => {
    const body = parse(
      z.object({
        graceDays: z.number().int().min(0).max(90),
        trialGraceDays: z.number().int().min(0).max(90),
        afterGrace: z.enum(['restricted', 'suspended']),
        suspendAfterDays: z.number().int().min(0).max(365).nullable(),
        renewalLeadDays: z.number().int().min(1).max(60),
        invoiceDueDays: z.number().int().min(0).max(90),
      }),
      req.body,
    );
    const policy = await saveBillingPolicy(body, userId());
    invalidateAccess();
    await audit({
      action: 'billing.policy_updated',
      entityType: 'billing_settings',
      instituteId: null,
      metadata: body,
    });
    res.json(policy);
  });

  b.get('/usage', async (req, res) => {
    const q = parse(
      z.object({ date: isoDate.optional(), instituteId: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    res.json(await usageSummary(q));
  });

  // Runs the hourly billing sweep now (renewal invoices, lapses, usage snapshots, overage).
  b.post('/sweep', async (_req, res) => {
    const result = await runBillingSweep();
    await audit({
      action: 'billing.sweep_run',
      entityType: 'billing_settings',
      instituteId: null,
      metadata: { ...result },
    });
    res.json(result);
  });

  a.use('/billing', b);
  api.use('/admin', a);
}

// ------------------------------------------------------------------ public

function publicRoutes(api: Router) {
  // Unauthenticated: the payload signature is verified with the operator's gateway credentials
  // before anything is trusted; replays are recognised by the gateway event id.
  api.post(
    '/subscriptions/public/webhooks/:gateway',
    webhookRateLimit,
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const { gateway } = parse(z.object({ gateway: z.string().regex(/^[a-z0-9-]{2,30}$/) }), req.params);
      const raw =
        req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
      const result = await processWebhook(gateway, raw, req.headers);
      res.json({ received: true, ...result });
    },
  );

  // The payer's browser coming back from a redirect checkout (see fees.routes.ts): the signed link
  // names the payment, which is re-checked with the gateway before the payer lands back in the app.
  const checkoutReturn = async (req: Request, res: Response) => {
    const target = verifyCheckoutReturn('saas', String(req.params.token ?? ''));
    if (target)
      await syncReturnedSaasPayment(target.instituteId, target.paymentId).catch((err: Error) =>
        logger.warn(
          { paymentId: target.paymentId, reason: err.message },
          'Checkout return status check failed',
        ),
      );
    sendCheckoutReturn(res, target);
  };
  api.get('/subscriptions/public/checkout-return/:token', webhookRateLimit, checkoutReturn);
  api.post(
    '/subscriptions/public/checkout-return/:token',
    webhookRateLimit,
    express.urlencoded({ extended: false, limit: '64kb' }),
    checkoutReturn,
  );

  // Short-lived signed link to an invoice / credit note PDF.
  api.get('/subscriptions/public/documents/:token', async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(1000) }), req.params);
    const doc = await renderSignedDocument(token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(doc.buffer);
  });
}

export function subscriptionRoutes(api: Router) {
  publicRoutes(api);
  adminRoutes(api);
  tenantRoutes(api);
}
