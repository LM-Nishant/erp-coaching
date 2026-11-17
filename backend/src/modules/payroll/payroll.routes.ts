import { Router, type Response } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { PAY_TYPES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { Employee } from '../hr/models';
import { currentEmployee, employeeRepo, visibleEmployeeIds } from '../hr/hr.service';
import { isoDate, monthBounds } from '../hr/dates';
import { PayrollRun, Payslip } from './models';
import {
  componentRepo,
  computeSettlement,
  createRun,
  createStructure,
  deleteRun,
  ensureDefaultComponents,
  generateRun,
  lineAmount,
  payslipPdf,
  payslipRepo,
  periodLabel,
  recordWorkUnits,
  runRepo,
  settlementRepo,
  structureRepo,
  transitionRun,
  transitionSettlement,
  visiblePayslips,
  workUnitRepo,
} from './payroll.service';
import { rupees, toCsv, toSpreadsheetXml, type Cell } from './export';

const date = z.string().regex(isoDate, 'Use YYYY-MM-DD');
const paise = z.number().int().min(0).max(1_000_000_000_00);
const pct = z.number().min(0).max(100);
const optStr = (max: number) => z.string().trim().max(max).nullable().optional();
const items = z.array(z.object({ name: z.string().trim().min(1).max(60), amount: paise })).max(30);
const period = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});
const format = z.object({ format: z.enum(['json', 'csv', 'xls']).default('json') });

const structureBody = z.object({
  employeeId: z.number().int().positive(),
  payType: z.enum(PAY_TYPES),
  monthlyBasic: paise.optional(),
  ratePerUnit: paise.optional(),
  allowances: items.nullable().optional(),
  deductions: items.nullable().optional(),
  pfApplicable: z.boolean().optional(),
  esiApplicable: z.boolean().optional(),
  ptApplicable: z.boolean().optional(),
  tdsApplicable: z.boolean().optional(),
  tdsPercent: pct.nullable().optional(),
  effectiveFrom: date,
  notes: optStr(500),
});

const componentFields = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{1,30}$/),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['earning', 'deduction']),
  calcType: z.enum(['percent', 'fixed', 'slab']),
  base: z.enum(['basic', 'gross']).default('basic'),
  employeeRate: pct.nullable().optional(),
  employerRate: pct.nullable().optional(),
  fixedAmount: paise.nullable().optional(),
  wageCeiling: paise.nullable().optional(),
  eligibilityMaxGross: paise.nullable().optional(),
  slabs: z
    .array(z.object({ upTo: paise.nullable(), amount: paise }))
    .max(20)
    .nullable()
    .optional(),
  effectiveFrom: date,
  effectiveTo: date.nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
const componentBody = componentFields
  .refine((c) => c.calcType !== 'slab' || (c.slabs && c.slabs.length > 0), {
    message: 'Slab components need slabs',
    path: ['slabs'],
  })
  .refine((c) => !c.effectiveTo || c.effectiveTo >= c.effectiveFrom, {
    message: 'effectiveTo must be after effectiveFrom',
    path: ['effectiveTo'],
  });

const workUnitBody = z.object({
  employeeId: z.number().int().positive(),
  date,
  unitType: z.enum(['lecture', 'class', 'incentive']),
  quantity: z.number().min(0).max(1000).optional(),
  amount: paise.optional(),
  description: optStr(255),
  referenceType: optStr(50),
  referenceId: optStr(50),
  externalRef: optStr(120),
});

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

function configRoutes(r: Router) {
  // ---- statutory & custom components (effective-dated)
  r.get('/components', requirePermission('payroll', 'view'), async (_req, res) => {
    await ensureDefaultComponents();
    res.json(
      await componentRepo.findAll({
        order: [
          ['sortOrder', 'ASC'],
          ['code', 'ASC'],
          ['effectiveFrom', 'DESC'],
        ],
      }),
    );
  });
  r.post('/components', requirePermission('payroll', 'configure'), async (req, res) => {
    const body = parse(componentBody, req.body);
    await ensureDefaultComponents();
    if (await componentRepo.count({ code: body.code, effectiveFrom: body.effectiveFrom }))
      throw Conflict('A version of this component already starts on that date', 'COMPONENT_EXISTS');
    const c = await componentRepo.create({
      ...body,
      statutory: ['PF', 'ESI', 'PT', 'TDS'].includes(body.code),
      employeeRate: body.employeeRate ?? null,
      employerRate: body.employerRate ?? null,
      fixedAmount: body.fixedAmount ?? null,
      wageCeiling: body.wageCeiling ?? null,
      eligibilityMaxGross: body.eligibilityMaxGross ?? null,
      slabs: body.slabs ?? null,
      effectiveTo: body.effectiveTo ?? null,
    });
    await audit({
      action: 'payroll.component.created',
      entityType: 'PayrollComponent',
      entityId: c.id,
      metadata: { after: c.toJSON() },
    });
    res.status(201).json(c);
  });
  r.patch('/components/:id', requirePermission('payroll', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(componentFields.omit({ code: true }).partial(), req.body);
    const c = await componentRepo.findById(id);
    const before = c.toJSON();
    await c.update(body);
    if (c.effectiveTo && c.effectiveTo < c.effectiveFrom)
      throw BadRequest('effectiveTo must be after effectiveFrom');
    await audit({
      action: 'payroll.component.updated',
      entityType: 'PayrollComponent',
      entityId: id,
      metadata: { before, after: c.toJSON() },
    });
    res.json(c);
  });
  r.delete('/components/:id', requirePermission('payroll', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const c = await componentRepo.destroy(id);
    await audit({
      action: 'payroll.component.deleted',
      entityType: 'PayrollComponent',
      entityId: id,
      metadata: { before: c.toJSON() },
    });
    res.status(204).end();
  });

  // ---- salary structures
  r.get('/structures', requirePermission('payroll', 'view'), async (req, res) => {
    const q = parse(
      z.object({
        employeeId: z.coerce.number().int().positive().optional(),
        current: z.coerce.boolean().optional(),
      }),
      req.query,
    );
    const ids = await visibleEmployeeIds(q.employeeId ? { id: q.employeeId } : {});
    res.json(
      await structureRepo.findAll({
        where: { employeeId: { [Op.in]: ids }, ...(q.current ? { effectiveTo: null } : {}) },
        include: [
          { model: Employee, as: 'employee', attributes: ['id', 'name', 'employeeCode', 'branchId'] },
        ],
        order: [
          ['employeeId', 'ASC'],
          ['effectiveFrom', 'DESC'],
        ],
      }),
    );
  });
  r.post('/structures', requirePermission('payroll', 'create'), async (req, res) => {
    const body = parse(structureBody, req.body);
    if (body.payType === 'fixed_monthly' ? !body.monthlyBasic : !body.ratePerUnit)
      throw BadRequest(
        body.payType === 'fixed_monthly' ? 'monthlyBasic is required' : 'ratePerUnit is required',
      );
    const s = await createStructure(body);
    await audit({
      action: 'payroll.structure.created',
      entityType: 'SalaryStructure',
      entityId: s.id,
      metadata: { after: s.toJSON() },
    });
    res.status(201).json(s);
  });
  r.patch('/structures/:id', requirePermission('payroll', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(structureBody.omit({ employeeId: true, effectiveFrom: true }).partial(), req.body);
    const s = await structureRepo.findById(id);
    await employeeRepo.findById(s.employeeId);
    const locked = await Payslip.count({
      where: { instituteId: s.instituteId, salaryStructureId: id },
      include: [{ model: PayrollRun, as: 'run', where: { status: { [Op.ne]: 'draft' } } }],
    });
    if (locked)
      throw Conflict(
        'Structure is used by an approved payroll run; add a new revision instead',
        'STRUCTURE_IN_USE',
      );
    const before = s.toJSON();
    await s.update(body);
    await audit({
      action: 'payroll.structure.updated',
      entityType: 'SalaryStructure',
      entityId: id,
      metadata: { before, after: s.toJSON() },
    });
    res.json(s);
  });
  r.delete('/structures/:id', requirePermission('payroll', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const s = await structureRepo.findById(id);
    await employeeRepo.findById(s.employeeId);
    if (await Payslip.count({ where: { instituteId: s.instituteId, salaryStructureId: id } }))
      throw Conflict('Structure is referenced by payslips', 'STRUCTURE_IN_USE');
    await s.destroy();
    await audit({
      action: 'payroll.structure.deleted',
      entityType: 'SalaryStructure',
      entityId: id,
      metadata: { before: s.toJSON() },
    });
    res.status(204).end();
  });
}

function workUnitRoutes(r: Router) {
  r.get('/work-units', requirePermission('payroll', 'view'), async (req, res) => {
    const q = parse(period.extend({ employeeId: z.coerce.number().int().positive().optional() }), req.query);
    const { start, end } = monthBounds(q.year, q.month);
    const ids = await visibleEmployeeIds(q.employeeId ? { id: q.employeeId } : {});
    res.json(
      await workUnitRepo.findAll({
        where: { employeeId: { [Op.in]: ids }, date: { [Op.between]: [start, end] } },
        include: [{ model: Employee, as: 'employee', attributes: ['id', 'name', 'employeeCode'] }],
        order: [
          ['date', 'ASC'],
          ['id', 'ASC'],
        ],
      }),
    );
  });
  r.post('/work-units', requirePermission('payroll', 'create'), async (req, res) => {
    const body = parse(workUnitBody, req.body);
    const result = await recordWorkUnits([body], 'manual');
    if (result.rejected.length) throw Conflict(result.rejected[0].reason, 'WORK_UNIT_REJECTED');
    const unit = result.items[0];
    await audit({
      action: 'payroll.work_unit.recorded',
      entityType: 'WorkUnit',
      entityId: unit.id,
      metadata: { after: unit.toJSON() },
    });
    res.status(result.created ? 201 : 200).json(unit);
  });
  /** Input API for other modules/integrations; `externalRef` makes retries idempotent. */
  r.post('/work-units/bulk', requirePermission('payroll', 'create'), async (req, res) => {
    const { entries } = parse(z.object({ entries: z.array(workUnitBody).min(1).max(2000) }), req.body);
    const result = await recordWorkUnits(entries, 'api');
    await audit({
      action: 'payroll.work_unit.bulk_recorded',
      entityType: 'WorkUnit',
      metadata: { created: result.created, updated: result.updated, rejected: result.rejected },
    });
    res.json({ created: result.created, updated: result.updated, rejected: result.rejected });
  });
  r.delete('/work-units/:id', requirePermission('payroll', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const unit = await workUnitRepo.findById(id);
    await employeeRepo.findById(unit.employeeId);
    if (unit.payrollRunId) throw Conflict('Work unit is part of a locked payroll run', 'WORK_UNIT_LOCKED');
    await unit.destroy();
    await audit({
      action: 'payroll.work_unit.deleted',
      entityType: 'WorkUnit',
      entityId: id,
      metadata: { before: unit.toJSON() },
    });
    res.status(204).end();
  });
}

function runRoutes(r: Router) {
  r.get('/runs', requirePermission('payroll', 'view'), async (req, res) => {
    const q = parse(paginationSchema.extend({ year: z.coerce.number().int().optional() }), req.query);
    const { rows, count } = await runRepo.findAndCountAll({
      where: q.year ? { periodYear: q.year } : {},
      order: [
        ['periodYear', 'DESC'],
        ['periodMonth', 'DESC'],
        ['id', 'DESC'],
      ],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows, count, q));
  });
  r.post('/runs', requirePermission('payroll', 'create'), async (req, res) => {
    const body = parse(
      z.object({
        periodYear: z.number().int().min(2000).max(2100),
        periodMonth: z.number().int().min(1).max(12),
        branchId: z.number().int().positive().nullable().optional(),
        notes: optStr(500),
      }),
      req.body,
    );
    const run = await createRun(body);
    await audit({
      action: 'payroll.run.created',
      entityType: 'PayrollRun',
      entityId: run.id,
      metadata: { after: run.toJSON() },
    });
    res.status(201).json(run);
  });
  r.get('/runs/:id', requirePermission('payroll', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const run = await runRepo.findById(id);
    const payslips = await payslipRepo.findAll({
      where: { payrollRunId: id },
      include: [
        { model: Employee, as: 'employee', attributes: ['id', 'name', 'employeeCode', 'designation'] },
      ],
      order: [['employeeId', 'ASC']],
    });
    res.json({ run, payslips });
  });
  r.post('/runs/:id/generate', requirePermission('payroll', 'create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const result = await generateRun(id);
    await audit({
      action: 'payroll.run.generated',
      entityType: 'PayrollRun',
      entityId: id,
      metadata: { generated: result.generated, skipped: result.skipped },
    });
    res.json(result);
  });
  r.post('/runs/:id/:action', requirePermission('payroll', 'approve'), async (req, res) => {
    const { id, action } = parse(
      idParam.extend({ action: z.enum(['approve', 'reopen', 'lock']) }),
      req.params,
    );
    const run = await transitionRun(id, action);
    await audit({
      action: `payroll.run.${action}`,
      entityType: 'PayrollRun',
      entityId: id,
      metadata: { status: run.status },
    });
    res.json(run);
  });
  r.delete('/runs/:id', requirePermission('payroll', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const run = await deleteRun(id);
    await audit({
      action: 'payroll.run.deleted',
      entityType: 'PayrollRun',
      entityId: id,
      metadata: { before: run.toJSON() },
    });
    res.status(204).end();
  });

  r.get('/payslips/:id', requirePermission('payroll', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const slip = await payslipRepo.findById(id, {
      include: [
        { model: Employee, as: 'employee', attributes: ['id', 'name', 'employeeCode', 'designation'] },
      ],
    });
    res.json(slip);
  });
  r.get('/payslips/:id/pdf', requirePermission('payroll', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await payslipPdf(await payslipRepo.findById(id)));
  });
}

function settlementRoutes(r: Router) {
  r.get('/settlements', requirePermission('payroll', 'view'), async (_req, res) => {
    const ids = await visibleEmployeeIds();
    res.json(
      await settlementRepo.findAll({
        where: { employeeId: { [Op.in]: ids } },
        include: [{ model: Employee, as: 'employee', attributes: ['id', 'name', 'employeeCode'] }],
        order: [['lastWorkingDay', 'DESC']],
      }),
    );
  });
  /** Computes (or recomputes while draft) the full-and-final settlement for a separation. */
  r.post('/settlements', requirePermission('payroll', 'create'), async (req, res) => {
    const body = parse(
      z.object({
        separationId: z.number().int().positive(),
        waiveNoticeRecovery: z.boolean().optional(),
        adjustments: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(100),
              type: z.enum(['earning', 'deduction']),
              amount: paise,
            }),
          )
          .max(20)
          .optional(),
        notes: optStr(500),
      }),
      req.body,
    );
    const s = await computeSettlement(body.separationId, body);
    await audit({
      action: 'payroll.settlement.computed',
      entityType: 'FinalSettlement',
      entityId: s.id,
      metadata: { after: s.toJSON() },
    });
    res.json(s);
  });
  r.post('/settlements/:id/:action', requirePermission('payroll', 'approve'), async (req, res) => {
    const { id, action } = parse(idParam.extend({ action: z.enum(['approve', 'pay']) }), req.params);
    const s = await transitionSettlement(id, action);
    await audit({ action: `payroll.settlement.${action}`, entityType: 'FinalSettlement', entityId: id });
    res.json(s);
  });
}

function reportRoutes(r: Router) {
  /** Salary register for one run. */
  r.get('/reports/register', requirePermission('payroll', 'export'), async (req, res) => {
    const q = parse(format.extend({ runId: z.coerce.number().int().positive() }), req.query);
    const run = await runRepo.findById(q.runId);
    const slips = await visiblePayslips({ payrollRunId: run.id }, ['draft', 'approved', 'locked']);
    const codes = [...new Map(slips.flatMap((s) => s.lines).map((l) => [`${l.type}:${l.code}`, l])).values()];
    const headers = [
      'Employee code',
      'Name',
      'Designation',
      'Payable days',
      'LOP days',
      ...codes.map((c) => c.name),
      'Gross',
      'Deductions',
      'Net',
      'Employer contributions',
    ];
    const rows = slips.map((s) => [
      s.employee?.employeeCode,
      s.employee?.name,
      s.employee?.designation,
      s.payableDays,
      s.lopDays,
      ...codes.map((c) => rupees(s.lines.find((l) => l.code === c.code && l.type === c.type)?.amount ?? 0)),
      rupees(s.gross),
      rupees(s.totalDeductions),
      rupees(s.net),
      rupees(s.employerContributions),
    ]);
    await audit({
      action: 'payroll.report.exported',
      entityType: 'PayrollRun',
      entityId: run.id,
      metadata: { report: 'register', format: q.format },
    });
    send(res, q.format, `Salary register ${periodLabel(run.periodYear, run.periodMonth)}`, headers, rows, {
      run,
      headers,
      rows,
    });
  });

  /** PF / ESI / PT / TDS for a month (approved and locked runs). */
  r.get('/reports/statutory', requirePermission('payroll', 'export'), async (req, res) => {
    const q = parse(format.merge(period), req.query);
    const slips = await visiblePayslips({ periodYear: q.year, periodMonth: q.month });
    const headers = [
      'Employee code',
      'Name',
      'PAN',
      'UAN',
      'ESI number',
      'Gross',
      'PF (employee)',
      'PF (employer)',
      'ESI (employee)',
      'ESI (employer)',
      'Professional tax',
      'TDS',
    ];
    const rows = slips.map((s) => [
      s.employee?.employeeCode,
      s.employee?.name,
      s.employee?.pan,
      s.employee?.uan,
      s.employee?.esiNumber,
      rupees(s.gross),
      rupees(lineAmount(s, 'PF')),
      rupees(lineAmount(s, 'PF_ER')),
      rupees(lineAmount(s, 'ESI')),
      rupees(lineAmount(s, 'ESI_ER')),
      rupees(lineAmount(s, 'PT')),
      rupees(lineAmount(s, 'TDS')),
    ]);
    await audit({
      action: 'payroll.report.exported',
      entityType: 'Payslip',
      metadata: { report: 'statutory', ...q },
    });
    send(res, q.format, `Statutory ${periodLabel(q.year, q.month)}`, headers, rows, { headers, rows });
  });

  /** Net pay per employee per month for a calendar year. */
  r.get('/reports/annual', requirePermission('payroll', 'export'), async (req, res) => {
    const q = parse(format.extend({ year: z.coerce.number().int().min(2000).max(2100) }), req.query);
    const slips = await visiblePayslips({ periodYear: q.year });
    const byEmp = new Map<number, { code?: string; name?: string; net: number[]; gross: number }>();
    for (const s of slips) {
      const e = byEmp.get(s.employeeId) ?? {
        code: s.employee?.employeeCode,
        name: s.employee?.name,
        net: Array(12).fill(0),
        gross: 0,
      };
      e.net[s.periodMonth - 1] += s.net;
      e.gross += s.gross;
      byEmp.set(s.employeeId, e);
    }
    const headers = [
      'Employee code',
      'Name',
      ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      'Total net',
      'Total gross',
    ];
    const rows = [...byEmp.values()].map((e) => [
      e.code,
      e.name,
      ...e.net.map(rupees),
      rupees(e.net.reduce((a, b) => a + b, 0)),
      rupees(e.gross),
    ]);
    await audit({
      action: 'payroll.report.exported',
      entityType: 'Payslip',
      metadata: { report: 'annual', ...q },
    });
    send(res, q.format, `Payroll summary ${q.year}`, headers, rows, { headers, rows });
  });
}

/** Employee self-service: own payslips from locked runs only. */
function selfServiceRoutes(r: Router) {
  const mine = async (id?: number) => {
    const emp = await currentEmployee();
    return Payslip.findAll({
      where: { instituteId: requireTenantContext().instituteId, employeeId: emp.id, ...(id ? { id } : {}) },
      include: [{ model: PayrollRun, as: 'run', attributes: ['id', 'status'], where: { status: 'locked' } }],
      order: [
        ['periodYear', 'DESC'],
        ['periodMonth', 'DESC'],
      ],
    });
  };
  r.get('/me/payslips', requirePermission('hr-self-service', 'view'), async (_req, res) => {
    res.json(await mine());
  });
  r.get('/me/payslips/:id', requirePermission('hr-self-service', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const [slip] = await mine(id);
    if (!slip) throw NotFound('Payslip');
    res.json(slip);
  });
  r.get('/me/payslips/:id/pdf', requirePermission('hr-self-service', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const [slip] = await mine(id);
    if (!slip) throw NotFound('Payslip');
    res.json(await payslipPdf(slip));
  });
}

export function payrollRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule('payroll'));
  selfServiceRoutes(r);
  configRoutes(r);
  workUnitRoutes(r);
  runRoutes(r);
  settlementRoutes(r);
  reportRoutes(r);
  api.use('/payroll', r);
}
