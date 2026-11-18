import express, { Router, type Request, type Response } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import {
  FEE_ADJUSTMENT_TYPES,
  FEE_COURSE_ENROLMENT_STATUSES,
  INSTALMENT_PLAN_TYPES,
  OFFLINE_PAYMENT_MODES,
  PAYMENT_GATEWAYS,
} from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { Student } from '../students/models';
import { linkedStudentIds } from '../guardians/guardian-access';
import {
  FeeAccount,
  FeeAdjustment,
  FeeConcessionRule,
  FeeCourseEnrolment,
  FeeHead,
  FeeLedgerEntry,
  FeePayment,
  FeeReceipt,
  FeeRefund,
  FeeStructure,
  FinanceCategory,
} from './models';
import { getFeeSettings, updateFeeSettings } from './settings.service';
import {
  createStructure,
  createStructureVersion,
  headRepo,
  ruleRepo,
  structureRepo,
  toStructureDto,
} from './structures.service';
import {
  accountDto,
  accountRepo,
  adjustmentDto,
  adjustmentRepo,
  cancelAccount,
  decideAdjustment,
  generateAccount,
  generateForBatch,
  getAccount,
  requestAdjustment,
} from './accounts.service';
import {
  cancelPayment,
  completeMockCheckout,
  createCheckout,
  decideOfflinePayment,
  paymentDto,
  paymentRepo,
  processWebhook,
  recordOfflinePayment,
  refundPayment,
  syncPaymentStatus,
} from './payments.service';
import { findReceipt, receiptDto, receiptPdfUrl } from './receipts';
import { quoteCourse, startCoursePurchase } from './course-sales';
import {
  courseEnrolmentBatchOptions,
  courseEnrolmentDtos,
  courseEnrolmentRepo,
  reconcileCourseEnrolment,
} from './course-enrolment';
import { enabledGateways, gatewayDto, gatewayRepo, upsertGatewayConfig } from './gateways.service';
import {
  bankAccountDto,
  bankRepo,
  cancelFinanceEntry,
  categoryRepo,
  collectionsReport,
  createFinanceEntry,
  dailyCashReport,
  entryDto,
  entryRepo,
  importStatement,
  matchSuggestions,
  outstandingReport,
  profitAndLoss,
  reconcileLine,
  statementDto,
  statementRepo,
} from './accounting.service';
import { ledgerBalances } from './ledger';
import { runInstituteSweep } from './jobs';
import { money, notifyStudent } from './notifications';
import { rupees, toCsv, toSpreadsheetXml, type Cell } from './export';
import { isoDate, today, auditFee } from './util';

const M = 'fees';
const can = (action: 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'export' | 'configure') =>
  requirePermission(M, action);
const acc = (action: 'view' | 'create' | 'edit' | 'delete' | 'export') =>
  requirePermission('accounting', action);

const date = z.string().regex(isoDate, 'Use YYYY-MM-DD');
const paise = z.number().int().min(0).max(100_000_000_000);
const positivePaise = paise.refine((v) => v > 0, 'Must be positive');
const optStr = (max: number) => z.string().trim().max(max).nullable().optional();
const optId = z.number().int().positive().nullable().optional();
const qId = z.coerce.number().int().positive().optional();
const format = z.object({ format: z.enum(['json', 'csv', 'xls']).default('json') });
const boolQ = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const planSchema = z.object({
  type: z.enum(INSTALMENT_PLAN_TYPES),
  count: z.number().int().min(1).max(60).optional(),
  firstDueDate: date.optional(),
  custom: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        dueDate: date,
        percent: z.number().min(0).max(100),
      }),
    )
    .max(60)
    .optional(),
});
const componentSchema = z.object({
  feeHeadId: optId,
  name: z.string().trim().max(100).optional(),
  amount: paise,
  taxable: z.boolean().optional(),
});
const structureBody = z.object({
  branchId: optId,
  kind: z.enum(['course', 'subject']).default('course'),
  courseId: optId,
  batchId: optId,
  subjectId: optId,
  academicSessionId: optId,
  name: z.string().trim().min(1).max(150),
  status: z.enum(['draft', 'active']).optional(),
  effectiveFrom: date.optional(),
  components: z.array(componentSchema).min(1).max(40),
  instalmentPlan: planSchema,
});
const versionBody = structureBody
  .pick({ name: true, effectiveFrom: true, components: true, instalmentPlan: true, academicSessionId: true })
  .partial();
const settingsBody = z
  .object({
    receiptFormat: z.string().trim().min(1).max(80),
    invoiceFormat: z.string().trim().min(1).max(80),
    gstEnabled: z.boolean(),
    gstin: z
      .string()
      .trim()
      .regex(/^[0-9A-Z]{15}$/, 'Invalid GSTIN')
      .nullable(),
    gstRatePercent: z.number().min(0).max(40),
    gstInclusive: z.boolean(),
    gstInterState: z.boolean(),
    sacCode: z.string().trim().max(10),
    lateFee: z
      .object({
        type: z.enum(['none', 'fixed', 'percent', 'per_day']),
        amount: paise,
        percent: z.number().min(0).max(100),
        graceDays: z.number().int().min(0).max(365),
        maxAmount: paise.nullable(),
      })
      .partial(),
    reminderDaysBefore: z.number().int().min(0).max(60),
    offlineApprovalRequired: z.boolean(),
    concessionApprovalThreshold: paise,
    entitlementAfterInstalment: z.number().int().min(1).max(60),
  })
  .partial();
const offlineBody = z.object({
  accountId: z.number().int().positive(),
  amount: positivePaise,
  mode: z.enum(OFFLINE_PAYMENT_MODES),
  referenceNo: optStr(100),
  chequeNumber: optStr(30),
  chequeDate: date.nullable().optional(),
  bankName: optStr(100),
  bankAccountId: optId,
  paidOn: date.optional(),
  notes: optStr(500),
});
const promoCode = z.string().trim().max(40).nullable().optional();
const checkoutBody = z.object({
  accountId: z.number().int().positive(),
  amount: positivePaise.optional(),
  gateway: z.enum(PAYMENT_GATEWAYS).optional(),
  couponCode: promoCode,
  referralCode: promoCode,
});
const coursePurchaseBody = z.object({
  studentId: optId,
  batchId: optId,
  gateway: z.enum(PAYMENT_GATEWAYS).optional(),
  couponCode: promoCode,
  referralCode: promoCode,
});
const adjustmentBody = z.object({
  type: z.enum(FEE_ADJUSTMENT_TYPES).default('discount'),
  mode: z.enum(['fixed', 'percent']).optional(),
  value: z.number().positive().optional(),
  ruleId: optId,
  reason: optStr(255),
});
const ruleBody = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['concession', 'scholarship', 'discount']),
  mode: z.enum(['fixed', 'percent']),
  value: z.number().positive(),
  requiresApproval: z.boolean().optional(),
  active: z.boolean().optional(),
  description: optStr(500),
});
const headBody = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(30),
  taxable: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
const reasonBody = z.object({ reason: optStr(500) });
const refundBody = z.object({
  amount: positivePaise.optional(),
  reason: optStr(255),
  reduceDues: z.boolean().optional(),
});

function idemKey(req: Request): string | null {
  const v = req.get('Idempotency-Key');
  if (!v) return null;
  if (v.length > 100) throw BadRequest('Idempotency-Key is too long');
  return v;
}

function send(
  res: Response,
  fmt: 'json' | 'csv' | 'xls',
  name: string,
  headers: string[],
  rows: Cell[][],
  json: unknown,
) {
  if (fmt === 'json') return res.json(json);
  const file = name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  if (fmt === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.csv"`);
    return res.send(toCsv(headers, rows));
  }
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}.xls"`);
  return res.send(toSpreadsheetXml(name, headers, rows));
}

/** Student ids the signed-in student/parent may see. */
async function myStudentIds(): Promise<number[]> {
  const { instituteId, userId } = requireTenantContext();
  if (!userId) return [];
  const own = await Student.findAll({ where: { instituteId, userId }, attributes: ['id'] });
  return [...new Set([...own.map((s) => s.id), ...(await linkedStudentIds())])];
}

async function assertMyAccount(accountId: number) {
  const { instituteId } = requireTenantContext();
  const ids = await myStudentIds();
  const a = await FeeAccount.findOne({ where: { instituteId, id: accountId } });
  if (!a || !ids.includes(a.studentId)) throw NotFound('Fee account');
  return a;
}

async function assertMyPayment(paymentId: number) {
  const { instituteId } = requireTenantContext();
  const ids = await myStudentIds();
  const p = await FeePayment.findOne({
    where: { instituteId, id: paymentId },
    include: ['student', 'receipt'],
  });
  if (!p || !ids.includes(p.studentId)) throw NotFound('Payment');
  return p;
}

async function shareReceipt(receipt: FeeReceipt) {
  const { instituteId } = requireTenantContext();
  const student = await Student.findOne({ where: { instituteId, id: receipt.studentId } });
  if (!student) throw NotFound('Student');
  const { url } = await receiptPdfUrl(receipt);
  const payment = await FeePayment.findOne({ where: { instituteId, id: receipt.paymentId } });
  await notifyStudent(
    'fees.receipt-share',
    student,
    {
      amount: money(receipt.amount),
      receiptNo: receipt.number,
      paidOn: payment?.paidOn ?? '',
      receiptUrl: url,
    },
    receipt.branchId,
    ['whatsapp'],
  );
  return { shared: true, url };
}

// ------------------------------------------------------------------ public webhooks

function publicRoutes(api: Router) {
  // Unauthenticated: the institute is resolved from the per-config secret webhook key and the
  // payload signature is verified before anything is trusted (see processWebhook).
  api.post(
    '/fees/public/webhooks/:gateway/:webhookKey',
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const { gateway, webhookKey } = parse(
        z.object({ gateway: z.enum(PAYMENT_GATEWAYS), webhookKey: z.string().min(10).max(80) }),
        req.params,
      );
      const raw =
        req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
      const result = await processWebhook(gateway, webhookKey, raw, req.headers);
      res.json({ received: true, ...result });
    },
  );
}

// ------------------------------------------------------------------ configuration

function configRoutes(r: Router) {
  r.get('/settings', can('view'), async (_req, res) => {
    res.json(await getFeeSettings());
  });
  r.put('/settings', can('configure'), async (req, res) => {
    const patch = parse(settingsBody, req.body);
    const { before, after } = await updateFeeSettings(patch as never);
    await auditFee({ action: 'fees.settings.update', entityType: 'fee_settings', before, after });
    res.json(after);
  });

  r.get('/heads', can('view'), async (_req, res) => {
    const rows = await headRepo.findAll({
      order: [
        ['sortOrder', 'ASC'],
        ['name', 'ASC'],
      ],
    });
    res.json(
      rows.map((h) => ({ id: h.id, name: h.name, code: h.code, taxable: h.taxable, active: h.active })),
    );
  });
  r.post('/heads', can('configure'), async (req, res) => {
    const body = parse(headBody, req.body);
    if (await headRepo.findOne({ where: { code: body.code } }))
      throw Conflict('Fee head code already exists', 'DUPLICATE_CODE');
    const h = await headRepo.create(body);
    await auditFee({ action: 'fees.head.create', entityType: 'fee_head', entityId: h.id, after: h.toJSON() });
    res.status(201).json(h);
  });
  r.patch('/heads/:id', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const before = (await headRepo.findById(id)).toJSON();
    const h = await headRepo.update(id, parse(headBody.partial(), req.body));
    await auditFee({
      action: 'fees.head.update',
      entityType: 'fee_head',
      entityId: id,
      before,
      after: h.toJSON(),
    });
    res.json(h);
  });
  r.delete('/heads/:id', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const h = await headRepo.update(id, { active: false });
    await auditFee({
      action: 'fees.head.deactivate',
      entityType: 'fee_head',
      entityId: id,
      after: { active: false },
    });
    res.json(h);
  });

  r.get('/rules', can('view'), async (_req, res) => {
    res.json(await ruleRepo.findAll({ order: [['name', 'ASC']] }));
  });
  r.post('/rules', can('configure'), async (req, res) => {
    const body = parse(ruleBody, req.body);
    if (body.mode === 'percent' && body.value > 100) throw BadRequest('Percentage cannot exceed 100');
    const rule = await ruleRepo.create({ ...body, description: body.description ?? null });
    await auditFee({
      action: 'fees.rule.create',
      entityType: 'fee_concession_rule',
      entityId: rule.id,
      after: rule.toJSON(),
    });
    res.status(201).json(rule);
  });
  r.patch('/rules/:id', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const before = (await ruleRepo.findById(id)).toJSON();
    const rule = await ruleRepo.update(id, parse(ruleBody.partial(), req.body));
    await auditFee({
      action: 'fees.rule.update',
      entityType: 'fee_concession_rule',
      entityId: id,
      before,
      after: rule.toJSON(),
    });
    res.json(rule);
  });

  r.get('/gateways', can('view'), async (_req, res) => {
    res.json((await gatewayRepo.findAll({ order: [['id', 'ASC']] })).map(gatewayDto));
  });
  r.put('/gateways/:gateway', can('configure'), async (req, res) => {
    const { gateway } = parse(z.object({ gateway: z.enum(PAYMENT_GATEWAYS) }), req.params);
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        isDefault: z.boolean().optional(),
        merchantId: optStr(100),
        secretKey: z.string().min(4).max(500).optional(),
        webhookSecret: z.string().min(4).max(500).optional(),
        extra: z.record(z.string(), z.string().max(200)).optional(),
        sandbox: z.boolean().optional(),
      }),
      req.body,
    );
    const { before, row } = await upsertGatewayConfig({ gateway, ...body });
    await auditFee({
      action: 'fees.gateway.configure',
      entityType: 'payment_gateway_config',
      entityId: row.id,
      before,
      after: gatewayDto(row),
    });
    res.json(gatewayDto(row));
  });

  r.post('/jobs/sweep', can('configure'), async (req, res) => {
    const { asOf } = parse(z.object({ asOf: date.optional() }), req.body ?? {});
    res.json(await runInstituteSweep(asOf));
  });
}

// ------------------------------------------------------------------ structures

function structureRoutes(r: Router) {
  r.get('/structures', can('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(['draft', 'active', 'archived']).optional(),
        kind: z.enum(['course', 'subject']).optional(),
        courseId: qId,
        batchId: qId,
        familyId: qId,
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    if (q.status) where.status = q.status;
    else where.status = { [Op.ne]: 'archived' };
    if (q.familyId) {
      where.familyId = q.familyId;
      delete where.status;
    }
    for (const k of ['kind', 'courseId', 'batchId'] as const) if (q[k]) where[k] = q[k];
    if (q.search) where.name = { [Op.like]: `%${q.search}%` };
    const { rows, count } = await structureRepo.findAndCountAll({
      where: where as WhereOptions<FeeStructure>,
      order: [
        ['name', 'ASC'],
        ['version', 'DESC'],
      ],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(toStructureDto), count, q));
  });
  r.get('/structures/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const s = await structureRepo.findById(id);
    const versions = await structureRepo.findAll({
      where: { familyId: s.familyId ?? s.id },
      order: [['version', 'DESC']],
    });
    res.json({ ...toStructureDto(s), versions: versions.map(toStructureDto) });
  });
  r.post('/structures', can('configure'), async (req, res) => {
    const s = await createStructure(parse(structureBody, req.body) as never);
    await auditFee({
      action: 'fees.structure.create',
      entityType: 'fee_structure',
      entityId: s.id,
      after: toStructureDto(s),
    });
    res.status(201).json(toStructureDto(s));
  });
  r.post('/structures/:id/versions', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const next = await createStructureVersion(id, parse(versionBody, req.body) as never);
    await auditFee({
      action: 'fees.structure.version',
      entityType: 'fee_structure',
      entityId: next.id,
      metadata: { previousId: id },
      after: toStructureDto(next),
    });
    res.status(201).json(toStructureDto(next));
  });
  r.patch('/structures/:id', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(150).optional(),
        status: z.enum(['draft', 'active', 'archived']).optional(),
      }),
      req.body,
    );
    const before = toStructureDto(await structureRepo.findById(id));
    const s = await structureRepo.update(id, body);
    await auditFee({
      action: 'fees.structure.update',
      entityType: 'fee_structure',
      entityId: id,
      before,
      after: toStructureDto(s),
    });
    res.json(toStructureDto(s));
  });
  r.delete('/structures/:id', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const s = await structureRepo.findById(id);
    const { instituteId } = requireTenantContext();
    if (await FeeAccount.count({ where: { instituteId, structureId: id } }))
      throw Conflict('Structure is used by fee accounts; archive it instead', 'IN_USE');
    await structureRepo.destroy(id);
    await auditFee({
      action: 'fees.structure.delete',
      entityType: 'fee_structure',
      entityId: id,
      before: toStructureDto(s),
    });
    res.status(204).end();
  });
}

// ------------------------------------------------------------------ accounts & adjustments

function accountRoutes(r: Router) {
  r.get('/accounts', can('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        studentId: qId,
        batchId: qId,
        courseId: qId,
        status: z.enum(['active', 'closed', 'cancelled']).optional(),
        dues: boolQ,
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    for (const k of ['studentId', 'batchId', 'courseId', 'status'] as const) if (q[k]) where[k] = q[k];
    const { rows, count } = await accountRepo.findAndCountAll({
      where: where as WhereOptions<FeeAccount>,
      include: [
        {
          model: Student,
          as: 'student',
          ...(q.search
            ? {
                where: {
                  [Op.or]: [
                    { name: { [Op.like]: `%${q.search}%` } },
                    { admissionNumber: { [Op.like]: `%${q.search}%` } },
                    { mobile: { [Op.like]: `%${q.search}%` } },
                  ],
                },
              }
            : {}),
        },
      ],
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    const asOf = await today();
    let items = rows.map((a) => accountDto(a, asOf));
    if (q.dues !== undefined) items = items.filter((a) => a.balance > 0 === q.dues);
    res.json(paginated(items, count, q));
  });
  r.get('/accounts/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const a = await getAccount(id);
    const { instituteId } = requireTenantContext();
    const [adjustments, payments] = await Promise.all([
      FeeAdjustment.findAll({ where: { instituteId, accountId: id }, order: [['id', 'DESC']] }),
      FeePayment.findAll({
        where: { instituteId, accountId: id },
        include: ['receipt'],
        order: [['id', 'DESC']],
      }),
    ]);
    res.json({ ...accountDto(a, await today(), { adjustments }), payments: payments.map(paymentDto) });
  });
  r.get('/accounts/:id/ledger', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await accountRepo.findById(id);
    const { instituteId } = requireTenantContext();
    const rows = await FeeLedgerEntry.findAll({
      where: { instituteId, feeAccountId: id },
      order: [['id', 'ASC']],
    });
    res.json(rows.map(ledgerDto));
  });
  r.post('/accounts', can('create'), async (req, res) => {
    const body = parse(
      z.object({
        studentId: z.number().int().positive(),
        structureId: z.number().int().positive(),
        title: z.string().trim().min(1).max(150).optional(),
        firstDueDate: date.optional(),
        batchId: optId,
      }),
      req.body,
    );
    const { account, created } = await generateAccount({ ...body, source: 'manual' });
    const asOf = await today();
    await auditFee({
      action: 'fees.account.create',
      entityType: 'fee_account',
      entityId: account.id,
      after: accountDto(account, asOf),
    });
    res.status(created ? 201 : 200).json(accountDto(await getAccount(account.id), asOf));
  });
  r.post('/accounts/generate-batch', can('create'), async (req, res) => {
    const body = parse(
      z.object({
        batchId: z.number().int().positive(),
        structureId: z.number().int().positive().optional(),
        firstDueDate: date.optional(),
      }),
      req.body,
    );
    const result = await generateForBatch(body.batchId, body.structureId, body.firstDueDate);
    await auditFee({
      action: 'fees.account.generate-batch',
      entityType: 'batch',
      entityId: body.batchId,
      metadata: result,
    });
    res.json(result);
  });
  r.post('/accounts/:id/cancel', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(reasonBody, req.body ?? {});
    await cancelAccount(id, reason ?? undefined);
    res.json(accountDto(await getAccount(id), await today()));
  });
  r.post('/accounts/:id/adjustments', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const adj = await requestAdjustment(
      id,
      parse(adjustmentBody, req.body) as never,
      hasPermission('fees.approve'),
    );
    res.status(201).json(adjustmentDto(adj));
  });
  r.get('/adjustments', can('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({ status: z.enum(['pending', 'approved', 'rejected']).optional() }),
      req.query,
    );
    const { rows, count } = await adjustmentRepo.findAndCountAll({
      where: q.status ? { status: q.status } : {},
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    // Respect branch scope: only adjustments of visible accounts.
    const visible = new Set(
      (
        await accountRepo.findAll({
          where: { id: { [Op.in]: rows.map((a) => a.accountId) } },
          attributes: ['id'],
        })
      ).map((a) => a.id),
    );
    res.json(paginated(rows.filter((a) => visible.has(a.accountId)).map(adjustmentDto), count, q));
  });
  r.post('/adjustments/:id/approve', can('approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(adjustmentDto(await decideAdjustment(id, true)));
  });
  r.post('/adjustments/:id/reject', can('approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(adjustmentDto(await decideAdjustment(id, false)));
  });
}

// ------------------------------------------------------------------ payments & receipts

function paymentRoutes(r: Router) {
  r.get('/payments', can('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        accountId: qId,
        studentId: qId,
        status: z.string().max(30).optional(),
        mode: z.string().max(20).optional(),
        approval: z.enum(['pending', 'approved', 'rejected', 'not_required']).optional(),
        from: date.optional(),
        to: date.optional(),
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    for (const k of ['accountId', 'studentId', 'status', 'mode'] as const) if (q[k]) where[k] = q[k];
    if (q.approval) where.approvalStatus = q.approval;
    if (q.from || q.to)
      where.paidOn = { ...(q.from ? { [Op.gte]: q.from } : {}), ...(q.to ? { [Op.lte]: q.to } : {}) };
    const { rows, count } = await paymentRepo.findAndCountAll({
      where: where as WhereOptions<FeePayment>,
      include: [
        'receipt',
        {
          model: Student,
          as: 'student',
          ...(q.search
            ? {
                where: {
                  [Op.or]: [
                    { name: { [Op.like]: `%${q.search}%` } },
                    { admissionNumber: { [Op.like]: `%${q.search}%` } },
                  ],
                },
              }
            : {}),
        },
      ],
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(paymentDto), count, q));
  });
  r.get('/payments/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const p = await paymentRepo.findById(id, { include: ['student', 'receipt'] });
    const refunds = await FeeRefund.findAll({
      where: { instituteId: p.instituteId, paymentId: id },
      order: [['id', 'ASC']],
    });
    res.json({ ...paymentDto(p), refunds });
  });
  r.post('/payments/offline', can('create'), async (req, res) => {
    const body = parse(offlineBody, req.body);
    const { payment, replay } = await recordOfflinePayment(body, idemKey(req), hasPermission('fees.approve'));
    res.status(replay ? 200 : 201).json(paymentDto(payment));
  });
  r.post('/payments/:id/approve', can('approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(paymentDto(await decideOfflinePayment(id, true)));
  });
  r.post('/payments/:id/reject', can('approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(reasonBody, req.body ?? {});
    res.json(paymentDto(await decideOfflinePayment(id, false, reason ?? undefined)));
  });
  r.post('/payments/checkout', can('create'), async (req, res) => {
    res
      .status(201)
      .json(await createCheckout({ ...parse(checkoutBody, req.body), idempotencyKey: idemKey(req) }));
  });
  r.post('/payments/:id/sync', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { outcome, payment } = await syncPaymentStatus(id);
    res.json({ outcome, payment: paymentDto(payment) });
  });
  r.post('/payments/:id/mock-complete', can('create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { outcome } = parse(
      z.object({ outcome: z.enum(['success', 'failed']).default('success') }),
      req.body ?? {},
    );
    const result = await completeMockCheckout(id, outcome);
    res.json({
      ...result,
      payment: paymentDto(await paymentRepo.findById(id, { include: ['student', 'receipt'] })),
    });
  });
  r.post('/payments/:id/refund', can('approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { refund, payment, replay } = await refundPayment(
      id,
      parse(refundBody, req.body ?? {}),
      idemKey(req),
    );
    res.status(replay ? 200 : 201).json({ refund, payment: paymentDto(payment) });
  });
  r.post('/payments/:id/cancel', can('approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(reasonBody, req.body ?? {});
    res.json(paymentDto(await cancelPayment(id, reason ?? null)));
  });

  r.get('/receipts/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const rc = await findReceipt(id);
    await paymentRepo.findById(rc.paymentId); // branch scope
    res.json(receiptDto(rc));
  });
  r.get('/receipts/:id/pdf', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const rc = await findReceipt(id);
    await paymentRepo.findById(rc.paymentId);
    res.json(await receiptPdfUrl(rc));
  });
  r.post('/receipts/:id/share', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const rc = await findReceipt(id);
    await paymentRepo.findById(rc.paymentId);
    res.json(await shareReceipt(rc));
  });
}

// ------------------------------------------------------------------ student / parent self-service

function selfRoutes(r: Router) {
  const mine = requirePermission('my-fees', 'view');
  const pay = requirePermission('my-fees', 'create');
  r.get('/me', mine, async (req, res) => {
    const { instituteId } = requireTenantContext();
    const { studentId } = parse(z.object({ studentId: qId }), req.query);
    const ids = await myStudentIds();
    const selected = studentId ?? ids[0];
    if (!selected || !ids.includes(selected)) throw NotFound('Student');
    const student = await Student.findOne({ where: { instituteId, id: selected } });
    if (!student) throw NotFound('Student');
    const students = await Student.findAll({
      where: { instituteId, id: { [Op.in]: ids } },
      attributes: ['id', 'name', 'admissionNumber'],
    });
    const accounts = await FeeAccount.findAll({
      where: { instituteId, studentId: selected, status: { [Op.ne]: 'cancelled' } },
      include: ['instalments'],
      order: [['id', 'DESC']],
    });
    const payments = await FeePayment.findAll({
      where: { instituteId, studentId: selected, status: { [Op.ne]: 'cancelled' } },
      include: ['receipt'],
      order: [['id', 'DESC']],
      limit: 100,
    });
    const gateways = (await enabledGateways()).map((g) => g.gateway);
    const asOf = await today();
    const dtos = accounts.map((a) => accountDto(a, asOf));
    res.json({
      student: { id: student.id, name: student.name, admissionNumber: student.admissionNumber },
      students: students.map((s) => ({ id: s.id, name: s.name, admissionNumber: s.admissionNumber })),
      accounts: dtos,
      payments: payments.map(paymentDto),
      gateways,
      totalDue: dtos.reduce((s, a) => s + Math.max(0, a.balance), 0),
    });
  });
  r.post('/me/checkout', pay, async (req, res) => {
    const body = parse(checkoutBody, req.body);
    await assertMyAccount(body.accountId);
    res.status(201).json(await createCheckout({ ...body, idempotencyKey: idemKey(req) }));
  });
  // Buying a course online (website "Buy" button → app → here).
  const myStudent = async (requested?: number | null) => {
    const ids = await myStudentIds();
    const selected = requested ?? ids[0];
    if (!selected || !ids.includes(selected)) throw NotFound('Student');
    return selected;
  };
  r.get('/me/courses/:id/quote', mine, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const q = parse(
      z.object({ studentId: qId, batchId: qId, coupon: z.string().trim().max(40).optional() }),
      req.query,
    );
    res.json(
      await quoteCourse({
        studentId: await myStudent(q.studentId),
        courseId: id,
        batchId: q.batchId ?? null,
        couponCode: q.coupon || null,
      }),
    );
  });
  r.post('/me/courses/:id/checkout', pay, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(coursePurchaseBody, req.body ?? {});
    res.status(201).json(
      await startCoursePurchase({
        ...body,
        studentId: await myStudent(body.studentId),
        courseId: id,
        idempotencyKey: idemKey(req),
      }),
    );
  });
  r.get('/me/payments/:id', mine, async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(paymentDto(await assertMyPayment(id)));
  });
  r.post('/me/payments/:id/mock-complete', pay, async (req, res) => {
    const { id } = parse(idParam, req.params);
    await assertMyPayment(id);
    const { outcome } = parse(
      z.object({ outcome: z.enum(['success', 'failed']).default('success') }),
      req.body ?? {},
    );
    const result = await completeMockCheckout(id, outcome);
    res.json({ ...result, payment: paymentDto(await assertMyPayment(id)) });
  });
  r.post('/me/payments/:id/sync', mine, async (req, res) => {
    const { id } = parse(idParam, req.params);
    await assertMyPayment(id);
    const { outcome } = await syncPaymentStatus(id);
    res.json({ outcome, payment: paymentDto(await assertMyPayment(id)) });
  });
  r.get('/me/receipts/:id/pdf', mine, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const rc = await findReceipt(id);
    await assertMyPayment(rc.paymentId);
    res.json(await receiptPdfUrl(rc));
  });
  r.post('/me/receipts/:id/share', mine, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const rc = await findReceipt(id);
    await assertMyPayment(rc.paymentId);
    res.json(await shareReceipt(rc));
  });
}

// ------------------------------------------------------------------ course purchase enrolments

/**
 * Admissions and batch enrolments produced by online course purchases. `awaiting_batch` is the
 * queue of paid students no batch could take; an admin assigns one.
 */
function courseEnrolmentRoutes(r: Router) {
  r.get('/course-enrolments', can('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(FEE_COURSE_ENROLMENT_STATUSES).optional(),
        branchId: qId,
        courseId: qId,
        studentId: qId,
      }),
      req.query,
    );
    const where: Record<string, unknown> = {};
    for (const k of ['status', 'branchId', 'courseId', 'studentId'] as const) if (q[k]) where[k] = q[k];
    const { rows, count } = await courseEnrolmentRepo.findAndCountAll({
      where: where as WhereOptions<FeeCourseEnrolment>,
      include: q.search
        ? [
            {
              model: Student,
              as: 'student',
              attributes: [],
              where: {
                [Op.or]: [
                  { name: { [Op.like]: `%${q.search}%` } },
                  { admissionNumber: { [Op.like]: `%${q.search}%` } },
                  { mobile: { [Op.like]: `%${q.search}%` } },
                ],
              },
            },
          ]
        : [],
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(await courseEnrolmentDtos(rows), count, q));
  });
  r.get('/course-enrolments/:id/batches', can('approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await courseEnrolmentBatchOptions(await courseEnrolmentRepo.findById(id)));
  });

  r.post('/course-enrolments/:id/assign', can('approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { batchId } = parse(z.object({ batchId: z.number().int().positive() }), req.body ?? {});
    const row = await courseEnrolmentRepo.findById(id);
    courseEnrolmentRepo.assertRowWritable(row);
    const saved = await reconcileCourseEnrolment(row.accountId, { batchId });
    if (!saved) throw NotFound('Course enrolment');
    res.json((await courseEnrolmentDtos([saved]))[0]);
  });
}

// ------------------------------------------------------------------ accounting & reports

function ledgerDto(e: FeeLedgerEntry) {
  return {
    id: e.id,
    journalKey: e.journalKey,
    line: e.line,
    date: e.entryDate,
    account: e.account,
    debit: e.debit,
    credit: e.credit,
    feeAccountId: e.feeAccountId,
    refType: e.refType,
    refId: e.refId,
    narration: e.narration,
  };
}

function accountingRoutes(r: Router) {
  r.get('/ledger', acc('view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        account: z.string().max(60).optional(),
        from: date.optional(),
        to: date.optional(),
      }),
      req.query,
    );
    const { instituteId } = requireTenantContext();
    const where: Record<string | symbol, unknown> = { instituteId };
    if (q.account) where.account = q.account;
    if (q.from || q.to)
      where.entryDate = { ...(q.from ? { [Op.gte]: q.from } : {}), ...(q.to ? { [Op.lte]: q.to } : {}) };
    const { rows, count } = await FeeLedgerEntry.findAndCountAll({
      where: where as WhereOptions<FeeLedgerEntry>,
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(ledgerDto), count, q));
  });
  r.get('/ledger/trial-balance', acc('view'), async (req, res) => {
    const q = parse(z.object({ from: date.optional(), to: date.optional() }).merge(format), req.query);
    const bal = await ledgerBalances({ from: q.from, to: q.to });
    const rows = Object.entries(bal)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([account, v]) => ({ account, ...v }));
    const totals = {
      debit: rows.reduce((s, x) => s + x.debit, 0),
      credit: rows.reduce((s, x) => s + x.credit, 0),
    };
    send(
      res,
      q.format,
      'trial-balance',
      ['Account', 'Debit', 'Credit', 'Balance'],
      rows.map((x) => [x.account, rupees(x.debit), rupees(x.credit), rupees(x.balance)]),
      { rows, totals, balanced: totals.debit === totals.credit },
    );
  });

  r.get('/bank-accounts', acc('view'), async (_req, res) => {
    const rows = await bankRepo.findAll({ order: [['name', 'ASC']] });
    res.json(await Promise.all(rows.map((b) => bankAccountDto(b))));
  });
  const bankBody = z.object({
    branchId: optId,
    name: z.string().trim().min(1).max(100),
    bankName: optStr(100),
    accountNumberLast4: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .optional(),
    ifsc: z
      .string()
      .trim()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC')
      .nullable()
      .optional(),
    openingBalance: z.number().int().optional(),
    active: z.boolean().optional(),
  });
  r.post('/bank-accounts', acc('create'), async (req, res) => {
    const b = parse(bankBody, req.body);
    const row = await bankRepo.create({
      ...b,
      branchId: b.branchId ?? null,
      bankName: b.bankName ?? null,
      accountNumberLast4: b.accountNumberLast4 ?? null,
      ifsc: b.ifsc ?? null,
    });
    await auditFee({
      action: 'accounting.bank.create',
      entityType: 'bank_account',
      entityId: row.id,
      after: row.toJSON(),
    });
    res.status(201).json(await bankAccountDto(row));
  });
  r.patch('/bank-accounts/:id', acc('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const before = (await bankRepo.findById(id)).toJSON();
    const row = await bankRepo.update(id, parse(bankBody.partial(), req.body));
    await auditFee({
      action: 'accounting.bank.update',
      entityType: 'bank_account',
      entityId: id,
      before,
      after: row.toJSON(),
    });
    res.json(await bankAccountDto(row));
  });
  r.get('/bank-accounts/:id/statement', acc('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await bankRepo.findById(id);
    const { status } = parse(
      z.object({ status: z.enum(['unmatched', 'matched', 'ignored']).optional() }),
      req.query,
    );
    const rows = await statementRepo.findAll({
      where: { bankAccountId: id, ...(status ? { status } : {}) },
      order: [
        ['txnDate', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: 500,
    });
    res.json(rows.map(statementDto));
  });
  r.post('/bank-accounts/:id/statement', acc('create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { lines, csv } = parse(
      z.object({
        lines: z
          .array(
            z.object({
              date,
              description: optStr(255).transform((v) => v ?? undefined),
              reference: optStr(100).transform((v) => v ?? undefined),
              amount: z.number().int(),
            }),
          )
          .max(2000)
          .optional(),
        csv: z.string().max(500_000).optional(),
      }),
      req.body,
    );
    const parsed = lines ?? parseStatementCsv(csv ?? '');
    if (!parsed.length) throw BadRequest('No statement lines');
    const rows = await importStatement(id, parsed);
    await auditFee({
      action: 'accounting.statement.import',
      entityType: 'bank_account',
      entityId: id,
      metadata: { lines: rows.length },
    });
    res.status(201).json(rows.map(statementDto));
  });
  r.get('/statement-lines/:id/suggestions', acc('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await matchSuggestions(id));
  });
  r.post('/statement-lines/:id/reconcile', acc('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        action: z.enum(['match', 'ignore', 'unmatch']),
        type: z.enum(['payment', 'finance_entry']).optional(),
        id: z.number().int().positive().optional(),
      }),
      req.body,
    );
    const line = await reconcileLine(id, body);
    await auditFee({
      action: `accounting.statement.${body.action}`,
      entityType: 'bank_statement_line',
      entityId: id,
      after: statementDto(line),
    });
    res.json(statementDto(line));
  });

  r.get('/finance/categories', acc('view'), async (_req, res) => {
    res.json(
      await categoryRepo.findAll({
        order: [
          ['kind', 'ASC'],
          ['name', 'ASC'],
        ],
      }),
    );
  });
  r.post('/finance/categories', acc('create'), async (req, res) => {
    const body = parse(
      z.object({ kind: z.enum(['expense', 'income']), name: z.string().trim().min(1).max(100) }),
      req.body,
    );
    const row = await categoryRepo.create(body);
    await auditFee({
      action: 'accounting.category.create',
      entityType: 'finance_category',
      entityId: row.id,
      after: row.toJSON(),
    });
    res.status(201).json(row);
  });
  r.patch('/finance/categories/:id', acc('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const before = (await categoryRepo.findById(id)).toJSON();
    const row = await categoryRepo.update(
      id,
      parse(
        z.object({ name: z.string().trim().min(1).max(100).optional(), active: z.boolean().optional() }),
        req.body,
      ),
    );
    await auditFee({
      action: 'accounting.category.update',
      entityType: 'finance_category',
      entityId: id,
      before,
      after: row.toJSON(),
    });
    res.json(row);
  });
  r.get('/finance/entries', acc('view'), async (req, res) => {
    const q = parse(
      paginationSchema
        .extend({
          kind: z.enum(['expense', 'income']).optional(),
          categoryId: qId,
          from: date.optional(),
          to: date.optional(),
        })
        .merge(format),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    if (q.kind) where.kind = q.kind;
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.from || q.to)
      where.entryDate = { ...(q.from ? { [Op.gte]: q.from } : {}), ...(q.to ? { [Op.lte]: q.to } : {}) };
    if (q.search) where.party = { [Op.like]: `%${q.search}%` };
    if (q.format !== 'json') {
      const rows = await entryRepo.findAll({
        where: where as WhereOptions,
        include: [{ model: FinanceCategory, as: 'category' }],
        order: [['entryDate', 'ASC']],
      });
      return send(
        res,
        q.format,
        'finance-entries',
        ['Date', 'Type', 'Category', 'Party', 'Mode', 'Reference', 'Amount', 'Tax', 'Status'],
        rows.map((e) => [
          e.entryDate,
          e.kind,
          e.category?.name ?? '',
          e.party,
          e.mode,
          e.reference,
          rupees(e.amount),
          rupees(e.tax),
          e.status,
        ]),
        null,
      );
    }
    const { rows, count } = await entryRepo.findAndCountAll({
      where: where as WhereOptions,
      order: [
        ['entryDate', 'DESC'],
        ['id', 'DESC'],
      ],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(entryDto), count, q));
  });
  r.post('/finance/entries', acc('create'), async (req, res) => {
    const body = parse(
      z.object({
        kind: z.enum(['expense', 'income']),
        categoryId: z.number().int().positive(),
        date: date.optional(),
        amount: positivePaise,
        tax: paise.optional(),
        mode: z.enum(OFFLINE_PAYMENT_MODES),
        bankAccountId: optId,
        branchId: optId,
        party: optStr(150),
        reference: optStr(100),
        notes: optStr(500),
        attachmentFileId: optId,
      }),
      req.body,
    );
    const e = await createFinanceEntry(body);
    await auditFee({
      action: `accounting.${e.kind}.create`,
      entityType: 'finance_entry',
      entityId: e.id,
      after: entryDto(e),
    });
    res.status(201).json(entryDto(e));
  });
  r.post('/finance/entries/:id/cancel', acc('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const e = await cancelFinanceEntry(id);
    await auditFee({
      action: 'accounting.entry.cancel',
      entityType: 'finance_entry',
      entityId: id,
      before: { status: 'recorded' },
      after: { status: 'cancelled' },
    });
    res.json(entryDto(e));
  });

  r.get('/reports/pnl', acc('view'), async (req, res) => {
    const q = parse(z.object({ from: date, to: date, branchId: qId }).merge(format), req.query);
    const pnl = await profitAndLoss(q.from, q.to, q.branchId);
    const rows: Cell[][] = [
      ...pnl.income.map((x) => ['Income', x.label, rupees(x.amount)] as Cell[]),
      ['Income', 'Total income', rupees(pnl.totalIncome)],
      ...pnl.expenditure.map((x) => ['Expenditure', x.label, rupees(x.amount)] as Cell[]),
      ['Expenditure', 'Total expenditure', rupees(pnl.totalExpenditure)],
      ['Net', pnl.net >= 0 ? 'Surplus' : 'Deficit', rupees(pnl.net)],
    ];
    send(res, q.format, `profit-loss-${q.from}-${q.to}`, ['Section', 'Head', 'Amount'], rows, pnl);
  });
}

function reportRoutes(r: Router) {
  r.get('/reports/summary', can('view'), async (_req, res) => {
    const t = await today();
    const monthStart = `${t.slice(0, 8)}01`;
    const [day, month, dues, approvals, adjustments] = await Promise.all([
      collectionsReport({ from: t, to: t }),
      collectionsReport({ from: monthStart, to: t }),
      outstandingReport({ asOf: t }),
      paymentRepo.count({ approvalStatus: 'pending', status: 'pending' }),
      adjustmentRepo.count({ status: 'pending' }),
    ]);
    res.json({
      todayCollection: day.totals.net,
      monthCollection: month.totals.net,
      outstanding: dues.totals.balance,
      overdue: dues.totals.overdue,
      defaulters: dues.items.filter((x) => x.overdue > 0).length,
      pendingPaymentApprovals: approvals,
      pendingAdjustments: adjustments,
    });
  });
  r.get('/reports/daily-cash', can('view'), async (req, res) => {
    const q = parse(z.object({ date: date.optional(), branchId: qId }).merge(format), req.query);
    const rep = await dailyCashReport(q.date ?? (await today()), q.branchId);
    const rows: Cell[][] = [
      ['', 'Opening cash', null, null, rupees(rep.opening)],
      ...rep.rows.map(
        (x) =>
          [
            x.journalKey,
            x.narration,
            x.in ? rupees(x.in) : null,
            x.out ? rupees(x.out) : null,
            null,
          ] as Cell[],
      ),
      ['', 'Closing cash', rupees(rep.cashIn), rupees(rep.cashOut), rupees(rep.closing)],
    ];
    send(
      res,
      q.format,
      `daily-cash-${rep.date}`,
      ['Journal', 'Particulars', 'In', 'Out', 'Balance'],
      rows,
      rep,
    );
  });
  r.get('/reports/collections', can('view'), async (req, res) => {
    const q = parse(
      z.object({ from: date, to: date, branchId: qId, mode: z.string().max(20).optional() }).merge(format),
      req.query,
    );
    const rep = await collectionsReport(q);
    send(
      res,
      q.format,
      `collections-${q.from}-${q.to}`,
      [
        'Date',
        'Receipt',
        'Student',
        'Admission no.',
        'Mode',
        'Reference',
        'Amount',
        'Gateway charge',
        'Refunded',
        'Net',
      ],
      rep.items.map((x) => [
        x.date,
        x.receiptNo,
        x.student,
        x.admissionNumber,
        x.mode,
        x.reference,
        rupees(x.amount),
        rupees(x.gatewayCharge),
        rupees(x.refunded),
        rupees(x.net),
      ]),
      rep,
    );
  });
  r.get('/reports/outstanding', can('view'), async (req, res) => {
    const q = parse(
      z.object({ asOf: date.optional(), branchId: qId, batchId: qId, courseId: qId }).merge(format),
      req.query,
    );
    const rep = await outstandingReport(q);
    send(
      res,
      q.format,
      `outstanding-${rep.asOf}`,
      [
        'Student',
        'Admission no.',
        'Mobile',
        'Account',
        'Net fee',
        'Paid',
        'Balance',
        'Overdue',
        'Oldest due',
      ],
      rep.items.map((x) => [
        x.student,
        x.admissionNumber,
        x.mobile,
        x.title,
        rupees(x.net),
        rupees(x.paid),
        rupees(x.balance),
        rupees(x.overdue),
        x.oldestDueDate,
      ]),
      rep,
    );
  });
}

/** CSV with header `date,description,reference,amount` (amount in rupees; negative = debit). */
function parseStatementCsv(csv: string) {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const start = /date/i.test(lines[0]) ? 1 : 0;
  return lines.slice(start).map((l, i) => {
    const cols = l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const [d, description, reference, amount] = cols;
    const n = Number(amount);
    if (!isoDate.test(d ?? '') || !Number.isFinite(n))
      throw BadRequest(`Invalid statement row ${i + start + 1}`);
    return { date: d, description, reference, amount: Math.round(n * 100) };
  });
}

export function feesRoutes(api: Router) {
  publicRoutes(api);
  const r = Router();
  r.use(authenticate, requireModule(M));
  configRoutes(r);
  structureRoutes(r);
  accountRoutes(r);
  paymentRoutes(r);
  selfRoutes(r);
  courseEnrolmentRoutes(r);
  accountingRoutes(r);
  reportRoutes(r);
  api.use('/fees', r);
}

export type { FeeHead, FeeConcessionRule };
