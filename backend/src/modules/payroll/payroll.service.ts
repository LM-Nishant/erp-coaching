import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Op, type Transaction, type WhereOptions } from 'sequelize';
import type { PayslipLine, StructureItem } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { getContext, requireTenantContext } from '../../shared/context';
import { Conflict, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { Institute } from '../institutes/institute.model';
import { FileObject } from '../files/file.model';
import { saveUploadedFile, signedUrlFor } from '../files/files.service';
import { Employee } from '../hr/models';
import {
  assetRepo,
  attendanceSummary,
  employeeRepo,
  ensureDefaultLeaveTypes,
  leaveBalances,
  leaveTypeRepo,
  separationRepo,
} from '../hr/hr.service';
import { addDays, daysInclusive, maxDate, minDate, monthBounds } from '../hr/dates';
import { FinalSettlement, PayrollComponent, PayrollRun, Payslip, SalaryStructure, WorkUnit } from './models';
import { calculatePayslip, DEFAULT_COMPONENTS, resolveComponents } from './calculator';
import { renderPdf, type PdfLine, type PdfText } from './pdf';

export const structureRepo = new TenantRepository(SalaryStructure, { entity: 'Salary structure' });
export const componentRepo = new TenantRepository(PayrollComponent, { entity: 'Payroll component' });
export const runRepo = new TenantRepository(PayrollRun, { entity: 'Payroll run', branchScoped: true });
export const payslipRepo = new TenantRepository(Payslip, { entity: 'Payslip', branchScoped: true });
export const workUnitRepo = new TenantRepository(WorkUnit, { entity: 'Work unit' });
export const settlementRepo = new TenantRepository(FinalSettlement, { entity: 'Settlement' });

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const periodLabel = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;

// ---------------------------------------------------------------- components

export async function ensureDefaultComponents(): Promise<void> {
  if ((await componentRepo.count()) > 0) return;
  for (const c of DEFAULT_COMPONENTS) await componentRepo.create({ ...c, statutory: true, active: true });
}

export async function componentsFor(start: string, end: string) {
  await ensureDefaultComponents();
  return resolveComponents(await componentRepo.findAll(), start, end);
}

// ---------------------------------------------------------------- salary structures

export interface StructureInput {
  employeeId: number;
  payType: SalaryStructure['payType'];
  monthlyBasic?: number;
  ratePerUnit?: number;
  allowances?: StructureItem[] | null;
  deductions?: StructureItem[] | null;
  pfApplicable?: boolean;
  esiApplicable?: boolean;
  ptApplicable?: boolean;
  tdsApplicable?: boolean;
  tdsPercent?: number | null;
  effectiveFrom: string;
  notes?: string | null;
}

/** Adds a new structure version; the previous open-ended one is closed the day before. */
export async function createStructure(input: StructureInput) {
  await employeeRepo.findById(input.employeeId);
  const later = await structureRepo.count({
    employeeId: input.employeeId,
    effectiveFrom: { [Op.gte]: input.effectiveFrom },
  });
  if (later)
    throw Conflict('A structure starting on or after this date exists; edit it instead', 'STRUCTURE_EXISTS');
  return getSequelize().transaction(async (transaction) => {
    const open = await structureRepo.findAll({
      where: { employeeId: input.employeeId, effectiveTo: null },
      transaction,
    });
    for (const s of open) await s.update({ effectiveTo: addDays(input.effectiveFrom, -1) }, { transaction });
    return structureRepo.create(
      {
        ...input,
        monthlyBasic: input.monthlyBasic ?? 0,
        ratePerUnit: input.ratePerUnit ?? 0,
        allowances: input.allowances ?? [],
        deductions: input.deductions ?? [],
        tdsPercent: input.tdsPercent ?? null,
        effectiveTo: null,
        notes: input.notes ?? null,
      },
      { transaction },
    );
  });
}

/** Latest structure overlapping the period (a mid-month revision applies to the whole month). */
async function structuresFor(employeeIds: number[], start: string, end: string) {
  const rows = employeeIds.length
    ? await structureRepo.findAll({
        where: {
          employeeId: { [Op.in]: employeeIds },
          effectiveFrom: { [Op.lte]: end },
          [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: start } }],
        },
        order: [['effectiveFrom', 'ASC']],
      })
    : [];
  const map = new Map<number, SalaryStructure>();
  for (const s of rows) map.set(s.employeeId, s);
  return map;
}

// ---------------------------------------------------------------- work units (input API)

export interface WorkUnitInput {
  employeeId: number;
  date: string;
  unitType: WorkUnit['unitType'];
  quantity?: number;
  amount?: number;
  description?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  /** Idempotency key: re-sending the same ref updates instead of duplicating. */
  externalRef?: string | null;
}

async function lockedPeriod(employeeId: number, date: string, transaction?: Transaction) {
  const [y, m] = date.split('-').map(Number);
  const slip = await Payslip.findOne({
    where: { instituteId: requireTenantContext().instituteId, employeeId, periodYear: y, periodMonth: m },
    include: [{ model: PayrollRun, as: 'run', where: { status: 'locked' }, attributes: ['id'] }],
    transaction,
  });
  return Boolean(slip);
}

/**
 * Records lecture/class counts and incentives for payroll. Other modules (e.g. academics
 * timetable) can call this directly or via `POST /api/payroll/work-units/bulk`.
 */
export async function recordWorkUnits(entries: WorkUnitInput[], source: 'manual' | 'api' = 'api') {
  const result = {
    created: 0,
    updated: 0,
    rejected: [] as { index: number; reason: string }[],
    items: [] as WorkUnit[],
  };
  const ids = [...new Set(entries.map((e) => e.employeeId))];
  const visible = new Set(
    (await employeeRepo.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id'] })).map((e) => e.id),
  );
  for (const [index, e] of entries.entries()) {
    if (!visible.has(e.employeeId)) {
      result.rejected.push({ index, reason: 'Employee not found' });
      continue;
    }
    if (await lockedPeriod(e.employeeId, e.date)) {
      result.rejected.push({ index, reason: 'Payroll for this period is locked' });
      continue;
    }
    const data = {
      employeeId: e.employeeId,
      date: e.date,
      unitType: e.unitType,
      quantity: e.unitType === 'incentive' ? (e.quantity ?? 1) : (e.quantity ?? 0),
      amount: e.unitType === 'incentive' ? (e.amount ?? 0) : 0,
      description: e.description ?? null,
      referenceType: e.referenceType ?? null,
      referenceId: e.referenceId ?? null,
      source,
      externalRef: e.externalRef ?? null,
    };
    const existing = e.externalRef
      ? await workUnitRepo.findOne({ where: { externalRef: e.externalRef } })
      : null;
    if (existing) {
      if (existing.payrollRunId) {
        result.rejected.push({ index, reason: 'Already paid in a locked payroll run' });
        continue;
      }
      await existing.update(data);
      result.updated++;
      result.items.push(existing);
    } else {
      result.items.push(await workUnitRepo.create(data));
      result.created++;
    }
  }
  return result;
}

// ---------------------------------------------------------------- payroll runs

export async function createRun(input: {
  periodYear: number;
  periodMonth: number;
  branchId?: number | null;
  notes?: string | null;
}) {
  const branchId = input.branchId ?? null;
  const scopeKey = branchId ? `b${branchId}` : 'all';
  const where = { periodYear: input.periodYear, periodMonth: input.periodMonth };
  if (
    await PayrollRun.count({ where: { ...where, instituteId: requireTenantContext().instituteId, scopeKey } })
  )
    throw Conflict('A payroll run already exists for this period', 'RUN_EXISTS');
  return runRepo.create({ ...where, branchId, scopeKey, notes: input.notes ?? null });
}

function assertStatus(run: PayrollRun, ...allowed: PayrollRun['status'][]) {
  if (!allowed.includes(run.status))
    throw Conflict(`Payroll run is ${run.status}; expected ${allowed.join(' or ')}`, 'RUN_STATUS');
}

/**
 * (Re)generates payslips for a draft run. Idempotent: one payslip per employee per run is
 * upserted, and payslips of employees no longer eligible are removed.
 */
export async function generateRun(runId: number) {
  const run = await runRepo.findById(runId);
  assertStatus(run, 'draft');
  const { instituteId } = requireTenantContext();
  const { start, end } = monthBounds(run.periodYear, run.periodMonth);
  const daysInMonth = daysInclusive(start, end);

  const employees = await Employee.findAll({
    where: {
      instituteId,
      ...(run.branchId ? { branchId: run.branchId } : {}),
      dateOfJoining: { [Op.lte]: end },
      [Op.or]: [{ dateOfExit: null }, { dateOfExit: { [Op.gte]: start } }],
      status: { [Op.ne]: 'suspended' },
    },
  });
  const otherRuns = await Payslip.findAll({
    where: {
      instituteId,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      payrollRunId: { [Op.ne]: run.id },
      employeeId: { [Op.in]: employees.map((e) => e.id) },
    },
    attributes: ['employeeId'],
  });
  const taken = new Set(otherRuns.map((p) => p.employeeId));
  const ids = employees.map((e) => e.id);
  const structures = await structuresFor(ids, start, end);
  const attendance = await attendanceSummary(ids, start, end);
  const components = await componentsFor(start, end);
  const units = ids.length
    ? await WorkUnit.findAll({
        where: {
          instituteId,
          employeeId: { [Op.in]: ids },
          date: { [Op.between]: [start, end] },
          [Op.or]: [{ payrollRunId: null }, { payrollRunId: run.id }],
        },
      })
    : [];

  const skipped: { employeeId: number; name: string; reason: string }[] = [];
  const keep: number[] = [];
  await getSequelize().transaction(async (transaction) => {
    for (const emp of employees) {
      const structure = structures.get(emp.id);
      if (taken.has(emp.id)) {
        skipped.push({
          employeeId: emp.id,
          name: emp.name,
          reason: 'Included in another run for this period',
        });
        continue;
      }
      if (!structure) {
        skipped.push({ employeeId: emp.id, name: emp.name, reason: 'No salary structure' });
        continue;
      }
      const empUnits = units.filter((u) => u.employeeId === emp.id);
      const sum = (t: WorkUnit['unitType']) =>
        empUnits.filter((u) => u.unitType === t).reduce((a, u) => a + u.quantity, 0);
      const incentives = empUnits.filter((u) => u.unitType === 'incentive').reduce((a, u) => a + u.amount, 0);
      const employedDays = daysInclusive(
        maxDate(start, emp.dateOfJoining),
        minDate(end, emp.dateOfExit ?? end),
      );
      const att = attendance.get(emp.id)!;
      const unitCounts = { lecture: sum('lecture'), class: sum('class') };
      const calc = calculatePayslip({
        structure,
        components,
        daysInMonth,
        employedDays,
        lopDays: att.lopDays,
        units: unitCounts,
        incentives,
      });
      const { lopDays, ...counts } = att;
      const data = {
        branchId: emp.branchId,
        salaryStructureId: structure.id,
        periodYear: run.periodYear,
        periodMonth: run.periodMonth,
        payType: structure.payType,
        daysInMonth,
        employedDays,
        lopDays,
        payableDays: calc.payableDays,
        attendance: counts,
        units: unitCounts,
        lines: calc.lines,
        gross: calc.gross,
        totalDeductions: calc.totalDeductions,
        net: calc.net,
        employerContributions: calc.employerContributions,
      };
      const existing = await Payslip.findOne({
        where: { instituteId, payrollRunId: run.id, employeeId: emp.id },
        transaction,
      });
      if (existing) await existing.update(data, { transaction });
      else
        await Payslip.create(
          { ...data, instituteId, payrollRunId: run.id, employeeId: emp.id },
          { transaction },
        );
      keep.push(emp.id);
    }
    await Payslip.destroy({
      where: {
        instituteId,
        payrollRunId: run.id,
        ...(keep.length ? { employeeId: { [Op.notIn]: keep } } : {}),
      },
      transaction,
    });
    await refreshTotals(run, transaction);
    await run.update({ generatedAt: new Date() }, { transaction });
  });
  return { run, generated: keep.length, skipped };
}

async function refreshTotals(run: PayrollRun, transaction?: Transaction) {
  const slips = await Payslip.findAll({
    where: { instituteId: run.instituteId, payrollRunId: run.id },
    transaction,
  });
  const total = (k: 'gross' | 'totalDeductions' | 'net' | 'employerContributions') =>
    slips.reduce((t, s) => t + s[k], 0);
  await run.update(
    {
      employeeCount: slips.length,
      totalGross: total('gross'),
      totalDeductions: total('totalDeductions'),
      totalNet: total('net'),
      totalEmployer: total('employerContributions'),
    },
    { transaction },
  );
}

export async function transitionRun(runId: number, action: 'approve' | 'reopen' | 'lock') {
  const run = await runRepo.findById(runId);
  const userId = getContext().userId ?? null;
  if (action === 'approve') {
    assertStatus(run, 'draft');
    if (!run.generatedAt || run.employeeCount === 0)
      throw Conflict('Generate payslips before approving', 'RUN_EMPTY');
    await run.update({ status: 'approved', approvedAt: new Date(), approvedBy: userId });
  } else if (action === 'reopen') {
    assertStatus(run, 'approved');
    await run.update({ status: 'draft', approvedAt: null, approvedBy: null });
  } else {
    assertStatus(run, 'approved');
    const { start, end } = monthBounds(run.periodYear, run.periodMonth);
    await getSequelize().transaction(async (transaction) => {
      const slips = await Payslip.findAll({
        where: { instituteId: run.instituteId, payrollRunId: run.id },
        attributes: ['employeeId'],
        transaction,
      });
      await WorkUnit.update(
        { payrollRunId: run.id },
        {
          where: {
            instituteId: run.instituteId,
            employeeId: { [Op.in]: slips.map((s) => s.employeeId) },
            date: { [Op.between]: [start, end] },
            payrollRunId: null,
          },
          transaction,
        },
      );
      await run.update({ status: 'locked', lockedAt: new Date(), lockedBy: userId }, { transaction });
    });
    await enqueueJob('payroll.render-payslips', { runId: run.id });
  }
  return run;
}

export async function deleteRun(runId: number) {
  const run = await runRepo.findById(runId);
  assertStatus(run, 'draft');
  await getSequelize().transaction(async (transaction) => {
    await Payslip.destroy({ where: { instituteId: run.instituteId, payrollRunId: run.id }, transaction });
    await run.destroy({ transaction });
  });
  return run;
}

// ---------------------------------------------------------------- PDF salary slips

const inr = (paise: number) =>
  `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function payslipPdfBuffer(institute: string, slip: Payslip, emp: Employee): Buffer {
  const t: PdfText[] = [];
  const l: PdfLine[] = [];
  t.push({ x: 50, y: 60, text: institute, size: 16, bold: true });
  t.push({ x: 50, y: 82, text: `Salary slip - ${periodLabel(slip.periodYear, slip.periodMonth)}`, size: 12 });
  l.push({ x1: 50, y1: 95, x2: 545, y2: 95 });
  const info: [string, string][] = [
    ['Employee', `${emp.name} (${emp.employeeCode})`],
    ['Designation', emp.designation ?? '-'],
    ['Department', emp.department ?? '-'],
    ['PAN / UAN', `${emp.pan ?? '-'} / ${emp.uan ?? '-'}`],
    ['Bank account', emp.bankAccountNumber ? `${emp.bankAccountNumber} (${emp.bankIfsc ?? ''})` : '-'],
    ['Days (month / payable / LOP)', `${slip.daysInMonth} / ${slip.payableDays} / ${slip.lopDays}`],
  ];
  if (slip.payType !== 'fixed_monthly')
    info.push(['Lectures / classes', `${slip.units?.lecture ?? 0} / ${slip.units?.class ?? 0}`]);
  let y = 115;
  for (const [k, v] of info) {
    t.push({ x: 50, y, text: k, bold: true });
    t.push({ x: 220, y, text: v });
    y += 16;
  }
  y += 10;
  l.push({ x1: 50, y1: y - 12, x2: 545, y2: y - 12 });
  t.push(
    { x: 50, y, text: 'Earnings', bold: true },
    { x: 290, y, text: 'Amount', bold: true, align: 'right' },
  );
  t.push(
    { x: 310, y, text: 'Deductions', bold: true },
    { x: 545, y, text: 'Amount', bold: true, align: 'right' },
  );
  l.push({ x1: 50, y1: y + 6, x2: 545, y2: y + 6 });
  const earnings = slip.lines.filter((x) => x.type === 'earning');
  const deductions = slip.lines.filter((x) => x.type === 'deduction');
  for (let i = 0; i < Math.max(earnings.length, deductions.length); i++) {
    y += 18;
    const e = earnings[i];
    const d = deductions[i];
    if (e) t.push({ x: 50, y, text: e.name }, { x: 290, y, text: inr(e.amount), align: 'right' });
    if (d) t.push({ x: 310, y, text: d.name }, { x: 545, y, text: inr(d.amount), align: 'right' });
  }
  y += 12;
  l.push({ x1: 50, y1: y, x2: 545, y2: y });
  y += 16;
  t.push(
    { x: 50, y, text: 'Gross earnings', bold: true },
    { x: 290, y, text: inr(slip.gross), bold: true, align: 'right' },
  );
  t.push(
    { x: 310, y, text: 'Total deductions', bold: true },
    { x: 545, y, text: inr(slip.totalDeductions), bold: true, align: 'right' },
  );
  y += 28;
  t.push({ x: 50, y, text: `Net pay: ${inr(slip.net)}`, size: 13, bold: true });
  const employer = slip.lines.filter((x) => x.type === 'employer');
  if (employer.length) {
    y += 24;
    t.push({
      x: 50,
      y,
      text: `Employer contributions: ${employer.map((x) => `${x.name} ${inr(x.amount)}`).join(', ')}`,
      size: 8,
    });
  }
  t.push({
    x: 50,
    y: 800,
    text: 'This is a system-generated salary slip and does not require a signature.',
    size: 8,
  });
  return renderPdf(t, l);
}

/** Stores the PDF once per payslip (locked runs only) and returns a short-lived signed URL. */
export async function payslipPdf(slip: Payslip) {
  const run = await PayrollRun.findOne({ where: { instituteId: slip.instituteId, id: slip.payrollRunId } });
  if (!run || run.status !== 'locked')
    throw Conflict('Salary slips are available once the payroll run is locked', 'RUN_NOT_LOCKED');
  let file = slip.pdfFileId
    ? await FileObject.findOne({ where: { instituteId: slip.instituteId, id: slip.pdfFileId } })
    : null;
  if (!file) {
    const emp = await Employee.findOne({ where: { instituteId: slip.instituteId, id: slip.employeeId } });
    const institute = await Institute.findByPk(slip.instituteId);
    if (!emp) throw NotFound('Employee');
    const buf = payslipPdfBuffer(institute?.name ?? 'Institute', slip, emp);
    const tempPath = path.join(os.tmpdir(), `payslip-${crypto.randomUUID()}.pdf`);
    await fs.promises.writeFile(tempPath, buf);
    file = await saveUploadedFile({
      tempPath,
      originalName: `payslip-${emp.employeeCode}-${slip.periodYear}-${String(slip.periodMonth).padStart(2, '0')}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: buf.length,
      module: 'payroll',
      branchId: slip.branchId,
    });
    await slip.update({ pdfFileId: file.id });
  }
  return signedUrlFor(file);
}

export async function renderRunPayslips(runId: number) {
  const { instituteId } = requireTenantContext();
  const slips = await Payslip.findAll({ where: { instituteId, payrollRunId: runId, pdfFileId: null } });
  for (const s of slips) await payslipPdf(s);
  return slips.length;
}

// ---------------------------------------------------------------- full & final settlement

export interface SettlementOptions {
  waiveNoticeRecovery?: boolean;
  adjustments?: { name: string; type: 'earning' | 'deduction'; amount: number }[];
  notes?: string | null;
}

/** Builds (or rebuilds while draft) the full-and-final settlement for an accepted separation. */
export async function computeSettlement(separationId: number, opts: SettlementOptions = {}) {
  const sep = await separationRepo.findById(separationId);
  const emp = await employeeRepo.findById(sep.employeeId);
  if (!['accepted', 'completed'].includes(sep.status))
    throw Conflict('Accept the resignation before settlement', 'SEPARATION_NOT_ACCEPTED');
  const existing = await settlementRepo.findOne({ where: { separationId } });
  if (existing && existing.status !== 'draft')
    throw Conflict('Settlement is already approved', 'SETTLEMENT_LOCKED');

  const lwd = sep.lastWorkingDay;
  const [y, m] = lwd.split('-').map(Number);
  const { start, end } = monthBounds(y, m);
  const structure = (await structuresFor([emp.id], start, lwd)).get(emp.id) ?? null;
  const daysInMonth = daysInclusive(start, end);
  const dailyRate = structure
    ? Math.round(
        (structure.monthlyBasic + (structure.allowances ?? []).reduce((t, a) => t + a.amount, 0)) /
          daysInMonth,
      )
    : 0;
  const perDayBasic = structure ? Math.round(structure.monthlyBasic / 30) : 0;
  const lines: PayslipLine[] = [];

  // 1. Salary for the final month if no payslip covers it yet.
  const paid = await Payslip.count({
    where: { instituteId: emp.instituteId, employeeId: emp.id, periodYear: y, periodMonth: m },
  });
  if (structure && !paid) {
    if (structure.payType === 'fixed_monthly') {
      const days = daysInclusive(maxDate(start, emp.dateOfJoining), lwd);
      const lop = (await attendanceSummary([emp.id], start, lwd)).get(emp.id)!.lopDays;
      const payable = Math.max(0, days - lop);
      lines.push({
        code: 'SALARY',
        name: `Salary for ${payable} day(s) of ${periodLabel(y, m)}`,
        type: 'earning',
        amount: payable * dailyRate,
      });
    }
  }
  if (structure) {
    const units = await WorkUnit.findAll({
      where: {
        instituteId: emp.instituteId,
        employeeId: emp.id,
        payrollRunId: null,
        date: { [Op.lte]: lwd },
      },
    });
    const qty = units
      .filter((u) => u.unitType === (structure.payType === 'per_lecture' ? 'lecture' : 'class'))
      .reduce((t, u) => t + u.quantity, 0);
    if (structure.payType !== 'fixed_monthly' && qty > 0)
      lines.push({
        code: 'UNIT_PAY',
        name: `Unpaid ${qty} unit(s)`,
        type: 'earning',
        amount: Math.round(qty * structure.ratePerUnit),
      });
    const incentives = units.filter((u) => u.unitType === 'incentive').reduce((t, u) => t + u.amount, 0);
    if (incentives > 0)
      lines.push({ code: 'INCENTIVE', name: 'Unpaid incentives', type: 'earning', amount: incentives });
  }

  // 2. Leave encashment for encashable types.
  await ensureDefaultLeaveTypes();
  const types = await leaveTypeRepo.findAll({ where: { encashable: true } });
  if (types.length && perDayBasic) {
    for (const b of await leaveBalances(emp.id, y)) {
      if (!types.some((t) => t.id === b.leaveTypeId) || !b.available || b.available <= 0) continue;
      lines.push({
        code: `ENCASH_${b.code}`,
        name: `${b.name} encashment (${b.available} day(s))`,
        type: 'earning',
        amount: Math.round(b.available * perDayBasic),
      });
    }
  }

  // 3. Notice-period shortfall recovery.
  const served = Math.max(0, daysInclusive(sep.submittedOn, lwd) - 1);
  const shortfall = Math.max(0, sep.noticePeriodDays - served);
  if (shortfall > 0 && perDayBasic && !opts.waiveNoticeRecovery)
    lines.push({
      code: 'NOTICE',
      name: `Notice shortfall (${shortfall} day(s))`,
      type: 'deduction',
      amount: shortfall * perDayBasic,
    });

  // 4. Unreturned or lost assets.
  for (const a of await assetRepo.findAll({
    where: { employeeId: emp.id, status: { [Op.in]: ['issued', 'lost'] } },
  })) {
    if (a.valuePaise > 0)
      lines.push({
        code: 'ASSET',
        name: `Asset recovery: ${a.name}${a.assetTag ? ` (${a.assetTag})` : ''}`,
        type: 'deduction',
        amount: a.valuePaise,
      });
  }

  for (const adj of opts.adjustments ?? [])
    lines.push({ code: 'ADJUSTMENT', name: adj.name, type: adj.type, amount: adj.amount });

  const net = lines.reduce(
    (t, l) => t + (l.type === 'earning' ? l.amount : l.type === 'deduction' ? -l.amount : 0),
    0,
  );
  const data = {
    employeeId: emp.id,
    separationId,
    lastWorkingDay: lwd,
    lines,
    net,
    notes: opts.notes ?? null,
  };
  if (existing) return existing.update(data);
  return settlementRepo.create(data);
}

export async function transitionSettlement(id: number, action: 'approve' | 'pay') {
  const s = await settlementRepo.findById(id);
  await employeeRepo.findById(s.employeeId);
  if (action === 'approve') {
    if (s.status !== 'draft') throw Conflict(`Settlement is ${s.status}`);
    return s.update({ status: 'approved', approvedAt: new Date(), approvedBy: getContext().userId ?? null });
  }
  if (s.status !== 'approved') throw Conflict('Approve the settlement before marking it paid');
  return s.update({ status: 'paid', paidAt: new Date() });
}

// ---------------------------------------------------------------- reports

export async function visiblePayslips(
  where: WhereOptions<Payslip>,
  statuses: PayrollRun['status'][] = ['approved', 'locked'],
) {
  return payslipRepo.findAll({
    where,
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: [
          'id',
          'name',
          'employeeCode',
          'designation',
          'department',
          'pan',
          'uan',
          'esiNumber',
          'bankAccountNumber',
          'bankIfsc',
        ],
      },
      {
        model: PayrollRun,
        as: 'run',
        attributes: ['id', 'status'],
        where: { status: { [Op.in]: statuses } },
      },
    ],
    order: [['employeeId', 'ASC']],
  });
}

export const lineAmount = (slip: Payslip, code: string) =>
  slip.lines.find((l) => l.code === code)?.amount ?? 0;
