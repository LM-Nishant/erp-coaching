import { Op, type Transaction } from 'sequelize';
import type {
  FeeAccountDto,
  FeeAdjustmentDto,
  FeeAdjustmentType,
  FeeInstalmentDto,
  AmountMode,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { requireTenantContext } from '../../shared/context';
import { Student } from '../students/api';
import { Batch, BatchStudent, Course } from '../academics/api';
import { FeeAccount, FeeAdjustment, FeeConcessionRule, FeeInstalment, FeeStructure } from './models';
import { buildSchedule, findStructureFor, structureRepo, type ScheduleLine } from './structures.service';
import { L, postJournal } from './ledger';
import { getFeeSettings } from './settings.service';
import { today, withLockRetry, auditFee } from './util';
import { evaluateEntitlement } from './entitlements';

export const accountRepo = new TenantRepository(FeeAccount, { branchScoped: true, entity: 'Fee account' });
export const adjustmentRepo = new TenantRepository(FeeAdjustment, { entity: 'Fee adjustment' });

const REDUCING: FeeAdjustmentType[] = ['discount', 'concession', 'scholarship', 'waiver'];

export function instalmentDto(i: FeeInstalment, now: string): FeeInstalmentDto {
  return {
    id: i.id,
    seq: i.seq,
    label: i.label,
    dueDate: i.dueDate,
    amount: i.amount,
    lateFee: i.lateFee,
    paid: i.paid,
    balance: i.balance,
    status: i.status,
    overdue: i.balance > 0 && i.dueDate < now,
  };
}

export function adjustmentDto(a: FeeAdjustment): FeeAdjustmentDto {
  return {
    id: a.id,
    accountId: a.accountId,
    type: a.type,
    mode: a.mode,
    value: a.value,
    amount: a.amount,
    reason: a.reason,
    ruleId: a.ruleId,
    status: a.status,
    requestedByUserId: a.requestedByUserId,
    decidedByUserId: a.decidedByUserId,
    createdAt: a.createdAt.toISOString(),
  };
}

export function accountDto(
  a: FeeAccount,
  asOf: string,
  extra: { adjustments?: FeeAdjustment[] } = {},
): FeeAccountDto {
  return {
    id: a.id,
    branchId: a.branchId,
    studentId: a.studentId,
    studentName: a.student?.name,
    admissionNumber: a.student?.admissionNumber,
    title: a.title,
    structureId: a.structureId,
    courseId: a.courseId,
    batchId: a.batchId,
    subjectId: a.subjectId,
    gross: a.gross,
    discount: a.discount,
    charges: a.charges,
    lateFee: a.lateFee,
    net: a.net,
    paid: a.paid,
    advance: a.advance,
    balance: a.balance,
    status: a.status,
    source: a.source,
    instalments: a.instalments?.sort((x, y) => x.seq - y.seq).map((i) => instalmentDto(i, asOf)),
    adjustments: extra.adjustments?.map(adjustmentDto),
    createdAt: a.createdAt.toISOString(),
  };
}

/** Loads an account (tenant + branch scoped, 404 otherwise) with student and instalments. */
export async function getAccount(id: number, transaction?: Transaction) {
  return accountRepo.findById(id, { include: ['student', 'instalments'], transaction });
}

/** Row-locks the account and its instalments for a posting transaction. */
export async function lockAccount(id: number, transaction: Transaction) {
  const { instituteId } = requireTenantContext();
  const account = await FeeAccount.findOne({
    where: { instituteId, id },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!account) throw NotFound('Fee account');
  const instalments = await FeeInstalment.findAll({
    where: { instituteId, accountId: id },
    order: [['seq', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  return { account, instalments };
}

export function instalmentStatus(i: FeeInstalment) {
  const due = i.amount + i.lateFee;
  if (due <= 0) return i.paid > 0 ? 'paid' : 'waived';
  return i.paid >= due ? 'paid' : i.paid > 0 ? 'partial' : 'pending';
}

/** Allocates `amount` to unpaid instalments in due order; returns per-instalment allocations. */
export async function allocateToInstalments(
  instalments: FeeInstalment[],
  amount: number,
  transaction: Transaction,
): Promise<{ instalmentId: number; amount: number }[]> {
  const out: { instalmentId: number; amount: number }[] = [];
  let left = amount;
  for (const i of instalments) {
    if (left <= 0) break;
    const bal = i.balance;
    if (bal <= 0) continue;
    const take = Math.min(bal, left);
    i.paid += take;
    i.status = instalmentStatus(i);
    await i.save({ transaction });
    out.push({ instalmentId: i.id, amount: take });
    left -= take;
  }
  return out;
}

/** Uses any advance (excess payments) of the account against newly due amounts. */
export async function applyAdvance(
  account: FeeAccount,
  instalments: FeeInstalment[],
  transaction: Transaction,
) {
  if (account.advance <= 0 || account.balance <= 0) return 0;
  const use = Math.min(account.advance, account.balance);
  const allocs = await allocateToInstalments(instalments, use, transaction);
  const used = allocs.reduce((s, a) => s + a.amount, 0);
  if (!used) return 0;
  account.advance -= used;
  account.paid += used;
  await account.save({ transaction });
  await postJournal(
    {
      key: `advance-apply:${account.id}:${account.paid}:${Date.now()}`,
      branchId: account.branchId,
      feeAccountId: account.id,
      refType: 'account',
      refId: account.id,
      narration: 'Advance adjusted against dues',
      lines: [
        { account: L.ADVANCE, debit: used },
        { account: L.RECEIVABLE, credit: used },
      ],
    },
    transaction,
  );
  return used;
}

export interface GenerateAccountInput {
  studentId: number;
  structureId: number;
  title?: string;
  firstDueDate?: string;
  source?: string;
  sourceRef?: string | null;
  batchId?: number | null;
}

/**
 * `sourceRef` of a student's account for a batch (one per structure family). Shared by "generate for
 * batch" and promotions, so neither bills a student twice for the same batch.
 */
export const batchSourceRef = (batchId: number, structure: FeeStructure, studentId: number) =>
  `batch:${batchId}:${structure.familyId ?? structure.id}:${studentId}`;

/** Creates a student fee account with its instalment schedule and the receivable journal. */
export async function generateAccount(
  input: GenerateAccountInput,
): Promise<{ account: FeeAccount; created: boolean }> {
  const { instituteId } = requireTenantContext();
  if (input.sourceRef) {
    const existing = await FeeAccount.findOne({ where: { instituteId, sourceRef: input.sourceRef } });
    if (existing) return { account: existing, created: false };
  }
  const student = await Student.findOne({ where: { instituteId, id: input.studentId } });
  if (!student) throw BadRequest('Student not found');
  accountRepo.assertBranchAllowed(student.branchId);
  const structure = await structureRepo.findById(input.structureId);
  if (structure.status !== 'active')
    throw Conflict('Only active fee structures can be assigned', 'STRUCTURE_INACTIVE');
  if (structure.branchId && structure.branchId !== student.branchId)
    throw BadRequest('Fee structure belongs to another branch');
  const plan = input.firstDueDate
    ? { ...structure.instalmentPlan, firstDueDate: input.firstDueDate }
    : structure.instalmentPlan;
  const schedule = buildSchedule(structure.total, plan, await today());
  try {
    return await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => ({
        account: await insertAccount(student, structure, schedule, input, transaction),
        created: true,
      })),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError' && input.sourceRef) {
      const existing = await FeeAccount.findOne({ where: { instituteId, sourceRef: input.sourceRef } });
      if (existing) return { account: existing, created: false };
    }
    throw err;
  }
}

/**
 * Inserts an account, its instalments and the receivable journal in the caller's transaction. The
 * caller has checked the student's branch and that the active structure may bill the student.
 */
export async function insertAccount(
  student: Student,
  structure: FeeStructure,
  schedule: ScheduleLine[],
  input: Pick<GenerateAccountInput, 'title' | 'source' | 'sourceRef' | 'batchId'>,
  transaction: Transaction,
): Promise<FeeAccount> {
  const { instituteId } = requireTenantContext();
  const taxableGross = structure.components.filter((c) => c.taxable).reduce((s, c) => s + c.amount, 0);
  const account = await accountRepo.create(
    {
      branchId: student.branchId,
      studentId: student.id,
      studentUserId: student.userId ?? null,
      structureId: structure.id,
      courseId: structure.courseId,
      batchId: input.batchId ?? structure.batchId,
      subjectId: structure.subjectId,
      academicSessionId: structure.academicSessionId,
      title: input.title ?? structure.name,
      gross: structure.total,
      taxableGross,
      source: input.source ?? 'manual',
      sourceRef: input.sourceRef ?? null,
    },
    { transaction },
  );
  const instalments = await FeeInstalment.bulkCreate(
    schedule.map((s) => ({ ...s, instituteId, accountId: account.id })),
    { transaction },
  );
  await postJournal(
    {
      key: `charge:${account.id}`,
      branchId: account.branchId,
      feeAccountId: account.id,
      refType: 'account',
      refId: account.id,
      narration: `Fees: ${account.title}`,
      lines: [
        { account: L.RECEIVABLE, debit: structure.total },
        { account: L.FEE_INCOME, credit: structure.total },
      ],
    },
    transaction,
  );
  if (structure.total === 0) await evaluateEntitlement(account, instalments, transaction);
  return account;
}

/** Generates accounts for every active student of a batch who doesn't have one for it yet. */
export async function generateForBatch(batchId: number, structureId?: number, firstDueDate?: string) {
  const { instituteId } = requireTenantContext();
  const batch = await Batch.findOne({ where: { instituteId, id: batchId } });
  if (!batch) throw NotFound('Batch');
  accountRepo.assertBranchAllowed(batch.branchId);
  const structure = structureId
    ? await structureRepo.findById(structureId)
    : await findStructureFor({ branchId: batch.branchId, courseId: batch.courseId, batchId });
  if (!structure) throw BadRequest('No active fee structure for this batch');
  const members = await BatchStudent.findAll({ where: { instituteId, batchId } });
  const userIds = members.map((m) => m.studentUserId);
  const students = userIds.length
    ? await Student.findAll({ where: { instituteId, userId: { [Op.in]: userIds } } })
    : [];
  let created = 0;
  for (const s of students) {
    const r = await generateAccount({
      studentId: s.id,
      structureId: structure.id,
      firstDueDate,
      source: 'batch',
      sourceRef: batchSourceRef(batchId, structure, s.id),
      batchId,
    });
    if (r.created) created++;
  }
  return { created, skipped: students.length - created, structureId: structure.id };
}

/** Called from the admissions hook: finds the right structure and creates the account once. */
export async function generateForAdmission(e: {
  applicationId: number;
  studentId: number;
  branchId: number;
  courseId: number | null;
  batchId: number | null;
}) {
  const { instituteId } = requireTenantContext();
  let courseId = e.courseId;
  if (!courseId && e.batchId)
    courseId = (await Batch.findOne({ where: { instituteId, id: e.batchId } }))?.courseId ?? null;
  const structure = await findStructureFor({ branchId: e.branchId, courseId, batchId: e.batchId });
  if (!structure) return null;
  const course = courseId ? await Course.findOne({ where: { instituteId, id: courseId } }) : null;
  const r = await generateAccount({
    studentId: e.studentId,
    structureId: structure.id,
    title: course ? `${course.name} fees` : structure.name,
    source: 'admission',
    sourceRef: `admission:${e.applicationId}`,
    batchId: e.batchId,
  });
  return r.account;
}

function computeAmount(mode: AmountMode, value: number, base: number) {
  return mode === 'percent' ? Math.round((base * value) / 100) : Math.round(value);
}

export interface AdjustmentInput {
  type: FeeAdjustmentType;
  mode?: AmountMode;
  value?: number;
  ruleId?: number | null;
  reason?: string | null;
}

/**
 * Requests a discount/concession/scholarship/waiver/extra charge. Reductions above the institute
 * threshold (or from rules that require it) wait for approval by a `fees.approve` user.
 */
export async function requestAdjustment(accountId: number, input: AdjustmentInput, canApprove: boolean) {
  const { instituteId, userId } = requireTenantContext();
  const account = await accountRepo.findById(accountId);
  if (account.status !== 'active') throw Conflict('Account is not active', 'ACCOUNT_INACTIVE');
  let { mode = 'fixed', value } = input;
  let { type } = input;
  let ruleRequiresApproval = false;
  if (input.ruleId) {
    const rule = await FeeConcessionRule.findOne({ where: { instituteId, id: input.ruleId, active: true } });
    if (!rule) throw BadRequest('Concession rule not found');
    mode = rule.mode;
    value = rule.value;
    type = rule.type;
    ruleRequiresApproval = rule.requiresApproval;
  }
  if (value == null || value <= 0) throw BadRequest('Adjustment value must be positive');
  if (mode === 'percent' && value > 100) throw BadRequest('Percentage cannot exceed 100');
  const amount = computeAmount(mode, value, account.gross);
  if (amount <= 0) throw BadRequest('Adjustment amount is zero');
  const settings = await getFeeSettings();
  const reducing = REDUCING.includes(type);
  const needsApproval =
    reducing && (ruleRequiresApproval || amount > settings.concessionApprovalThreshold) && !canApprove;
  const adj = await adjustmentRepo.create({
    accountId,
    ruleId: input.ruleId ?? null,
    type,
    mode,
    value,
    amount,
    reason: input.reason ?? null,
    status: 'pending',
    requestedByUserId: userId ?? null,
  });
  await auditFee({
    action: 'fees.adjustment.request',
    entityType: 'fee_adjustment',
    entityId: adj.id,
    after: adj.toJSON(),
  });
  if (!needsApproval) return decideAdjustment(adj.id, true);
  return adj;
}

export async function decideAdjustment(id: number, approve: boolean) {
  const { userId } = requireTenantContext();
  const adj = await adjustmentRepo.findById(id);
  if (adj.status !== 'pending') throw Conflict('Adjustment already decided', 'ALREADY_DECIDED');
  await accountRepo.findById(adj.accountId); // branch scope check
  const result = await withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      const fresh = await FeeAdjustment.findOne({
        where: { instituteId: adj.instituteId, id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!fresh || fresh.status !== 'pending')
        throw Conflict('Adjustment already decided', 'ALREADY_DECIDED');
      if (!approve) {
        await fresh.update(
          { status: 'rejected', decidedByUserId: userId ?? null, decidedAt: new Date() },
          { transaction },
        );
        return fresh;
      }
      const { account, instalments } = await lockAccount(fresh.accountId, transaction);
      if (REDUCING.includes(fresh.type)) {
        const reducible = account.net - account.paid;
        const amount = Math.min(fresh.amount, Math.max(0, reducible));
        if (amount <= 0) throw Conflict('Nothing left to discount on this account', 'NOTHING_DUE');
        await reduceInstalments(instalments, amount, transaction);
        account.discount += amount;
        await account.save({ transaction });
        await postJournal(
          {
            key: `adjustment:${fresh.id}`,
            branchId: account.branchId,
            feeAccountId: account.id,
            refType: 'adjustment',
            refId: fresh.id,
            narration: `${fresh.type}${fresh.reason ? `: ${fresh.reason}` : ''}`,
            lines: [
              { account: L.DISCOUNTS, debit: amount },
              { account: L.RECEIVABLE, credit: amount },
            ],
          },
          transaction,
        );
        await fresh.update(
          { status: 'approved', amount, decidedByUserId: userId ?? null, decidedAt: new Date() },
          { transaction },
        );
      } else {
        const seq = (instalments.at(-1)?.seq ?? 0) + 1;
        const inst = await FeeInstalment.create(
          {
            instituteId: account.instituteId,
            accountId: account.id,
            seq,
            label: fresh.reason?.slice(0, 100) || 'Additional charge',
            dueDate: await today(),
            amount: fresh.amount,
          },
          { transaction },
        );
        instalments.push(inst);
        account.charges += fresh.amount;
        await account.save({ transaction });
        await postJournal(
          {
            key: `adjustment:${fresh.id}`,
            branchId: account.branchId,
            feeAccountId: account.id,
            refType: 'adjustment',
            refId: fresh.id,
            narration: fresh.reason ?? 'Additional charge',
            lines: [
              { account: L.RECEIVABLE, debit: fresh.amount },
              { account: L.FEE_INCOME, credit: fresh.amount },
            ],
          },
          transaction,
        );
        await applyAdvance(account, instalments, transaction);
        await fresh.update(
          { status: 'approved', decidedByUserId: userId ?? null, decidedAt: new Date() },
          { transaction },
        );
      }
      await evaluateEntitlement(account, instalments, transaction);
      return fresh;
    }),
  );
  await auditFee({
    action: approve ? 'fees.adjustment.approve' : 'fees.adjustment.reject',
    entityType: 'fee_adjustment',
    entityId: id,
    before: { status: 'pending' },
    after: { status: result.status, amount: result.amount },
  });
  return result;
}

/** Reduces unpaid instalment amounts, latest first (discounts never touch paid portions). */
export async function reduceInstalments(
  instalments: FeeInstalment[],
  amount: number,
  transaction: Transaction,
) {
  let left = amount;
  for (const i of [...instalments].sort((a, b) => b.seq - a.seq)) {
    if (left <= 0) break;
    const reducible = Math.max(0, i.amount - Math.max(0, i.paid - i.lateFee));
    const take = Math.min(reducible, left);
    if (!take) continue;
    i.amount -= take;
    i.status = instalmentStatus(i);
    await i.save({ transaction });
    left -= take;
  }
  if (left > 0) throw Conflict('Reduction exceeds the unpaid fees', 'NOTHING_DUE');
}

/** Applies the configured late fee to one overdue instalment (idempotent per day for per_day). */
export async function applyLateFee(instalmentId: number, asOf: string): Promise<number> {
  const settings = await getFeeSettings();
  const cfg = settings.lateFee;
  if (cfg.type === 'none') return 0;
  const { instituteId } = requireTenantContext();
  return withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      const inst = await FeeInstalment.findOne({
        where: { instituteId, id: instalmentId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!inst || inst.balance <= 0) return 0;
      const graceEnd = new Date(`${inst.dueDate}T00:00:00Z`);
      graceEnd.setUTCDate(graceEnd.getUTCDate() + cfg.graceDays);
      if (asOf <= graceEnd.toISOString().slice(0, 10)) return 0;
      let add = 0;
      if (cfg.type === 'per_day') {
        if (inst.lateFeeAppliedOn && inst.lateFeeAppliedOn >= asOf) return 0;
        add = cfg.amount;
      } else {
        if (inst.lateFeeAppliedOn) return 0;
        add =
          cfg.type === 'fixed'
            ? cfg.amount
            : Math.round(((inst.amount - Math.min(inst.paid, inst.amount)) * cfg.percent) / 100);
      }
      if (cfg.maxAmount != null) add = Math.min(add, Math.max(0, cfg.maxAmount - inst.lateFee));
      if (add <= 0) {
        await inst.update({ lateFeeAppliedOn: asOf }, { transaction });
        return 0;
      }
      const { account, instalments } = await lockAccount(inst.accountId, transaction);
      const locked = instalments.find((i) => i.id === inst.id)!;
      locked.lateFee += add;
      locked.lateFeeAppliedOn = asOf;
      locked.status = instalmentStatus(locked);
      await locked.save({ transaction });
      account.lateFee += add;
      await account.save({ transaction });
      await postJournal(
        {
          key: `late-fee:${inst.id}:${asOf}`,
          date: asOf,
          branchId: account.branchId,
          feeAccountId: account.id,
          refType: 'instalment',
          refId: inst.id,
          narration: `Late fee: ${inst.label}`,
          lines: [
            { account: L.RECEIVABLE, debit: add },
            { account: L.LATE_FEE_INCOME, credit: add },
          ],
        },
        transaction,
      );
      await applyAdvance(account, instalments, transaction);
      return add;
    }),
  );
}

export async function cancelAccount(id: number, reason?: string) {
  const account = await accountRepo.findById(id);
  accountRepo.assertRowWritable(account);
  if (account.status !== 'active') throw Conflict('Account is not active', 'ACCOUNT_INACTIVE');
  if (account.paid > 0 || account.advance > 0)
    throw Conflict('Refund or reallocate payments before cancelling this account', 'ACCOUNT_HAS_PAYMENTS');
  await getSequelize().transaction(async (transaction) => {
    const { account: a, instalments } = await lockAccount(id, transaction);
    const outstanding = a.net - a.paid;
    if (outstanding > 0)
      await postJournal(
        {
          key: `account-cancel:${a.id}`,
          branchId: a.branchId,
          feeAccountId: a.id,
          refType: 'account',
          refId: a.id,
          narration: `Account cancelled${reason ? `: ${reason}` : ''}`,
          lines: [
            { account: L.FEE_INCOME, debit: outstanding },
            { account: L.RECEIVABLE, credit: outstanding },
          ],
        },
        transaction,
      );
    await a.update({ status: 'cancelled' }, { transaction });
    // A cancelled account no longer pays for its course: revoke the entitlement (and, for an online
    // purchase, queue taking the student back out of the batch it enrolled them in).
    await evaluateEntitlement(a, instalments, transaction);
  });
  await auditFee({
    action: 'fees.account.cancel',
    entityType: 'fee_account',
    entityId: id,
    before: { status: 'active' },
    after: { status: 'cancelled', reason },
  });
}

export type { FeeStructure };
