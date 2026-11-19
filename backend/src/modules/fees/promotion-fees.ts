import { Op, type Transaction } from 'sequelize';
import type {
  InstalmentPlan,
  PromotionFeeRequest,
  PromotionFeeStructureOption,
  PromotionFeeStudentResult,
} from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, Forbidden } from '../../shared/errors';
import { Student } from '../students/api';
import type { PromotionFeePlan, PromotionFeeProvider, PromotionFeeTarget } from '../academics/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { FeeAccount, type FeeStructure } from './models';
import { batchSourceRef, insertAccount } from './accounts.service';
import { buildSchedule, structureRepo, type ScheduleLine } from './structures.service';
import { auditFee, today } from './util';

/**
 * How specifically a course structure fits the target batch (lower wins), or undefined when it doesn't
 * apply: the batch's own structure, then the batch's session (branch before institute-wide), then
 * structures without a session. Another session's structures never bill the new session.
 */
export function promotionStructureRank(
  s: Pick<FeeStructure, 'kind' | 'batchId' | 'courseId' | 'branchId' | 'academicSessionId'>,
  t: PromotionFeeTarget,
): number | undefined {
  if (s.kind !== 'course') return undefined;
  if (s.batchId !== null) return s.batchId === t.batchId ? 0 : undefined;
  if (s.courseId !== t.courseId) return undefined;
  if (s.branchId !== null && s.branchId !== t.branchId) return undefined;
  if (s.academicSessionId !== null && s.academicSessionId !== t.academicSessionId) return undefined;
  return 1 + (s.academicSessionId === null ? 2 : 0) + (s.branchId === null ? 1 : 0);
}

/** Active structures that may bill the target batch, best first (then highest version, newest). */
async function applicableStructures(t: PromotionFeeTarget): Promise<FeeStructure[]> {
  const rows = await structureRepo.findAll({
    where: {
      status: 'active',
      kind: 'course',
      [Op.or]: [{ batchId: t.batchId }, { batchId: null, courseId: t.courseId }],
    },
    order: [
      ['version', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const ranked = rows
    .map((s) => ({ s, rank: promotionStructureRank(s, t) }))
    .filter((r): r is { s: FeeStructure; rank: number } => r.rank !== undefined);
  // Array#sort is stable, so the query's version/id order breaks ties.
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.s);
}

const toOption = (s: FeeStructure): PromotionFeeStructureOption => ({
  id: s.id,
  name: s.name,
  version: s.version,
  total: s.total,
  branchId: s.branchId,
  batchId: s.batchId,
  academicSessionId: s.academicSessionId,
  instalmentPlan: s.instalmentPlan,
});

async function assertFeesEnabled() {
  const { instituteId } = requireTenantContext();
  if (!(await isModuleEnabled(instituteId, 'fees')))
    throw Forbidden('The fees module is not enabled for this institute', 'MODULE_DISABLED');
}

async function chooseStructure(t: PromotionFeeTarget, structureId?: number): Promise<FeeStructure> {
  if (!structureId) {
    const [best] = await applicableStructures(t);
    if (!best) throw BadRequest('No active fee structure applies to the target batch');
    return best;
  }
  const structure = await structureRepo.findById(structureId);
  if (structure.status !== 'active')
    throw Conflict('Only active fee structures can be assigned', 'STRUCTURE_INACTIVE');
  if (promotionStructureRank(structure, t) === undefined)
    throw BadRequest(
      "The fee structure doesn't apply to the target batch (another course, batch, branch or session)",
    );
  return structure;
}

/**
 * Bills each promoted student once per batch and structure family (the `generateForBatch` key, so a
 * later "generate for batch" skips them). Students who can't be billed are skipped with a reason.
 */
async function billStudents(
  t: PromotionFeeTarget,
  structure: FeeStructure,
  schedule: ScheduleLine[],
  studentUserIds: number[],
  transaction: Transaction,
): Promise<PromotionFeeStudentResult[]> {
  const { instituteId, allowedBranchIds } = requireTenantContext();
  const students = await Student.findAll({
    where: { instituteId, userId: { [Op.in]: studentUserIds } },
    transaction,
  });
  const byUser = new Map(students.map((s) => [s.userId, s]));
  const refs = students.map((s) => batchSourceRef(t.batchId, structure, s.id));
  const billed = new Map(
    (refs.length
      ? await FeeAccount.findAll({
          where: { instituteId, sourceRef: { [Op.in]: refs } },
          attributes: ['id', 'sourceRef'],
          transaction,
        })
      : []
    ).map((a) => [a.sourceRef, a.id]),
  );
  const results: PromotionFeeStudentResult[] = [];
  for (const studentUserId of studentUserIds) {
    const student = byUser.get(studentUserId);
    const skip = (reason: string, accountId?: number) =>
      results.push({
        studentUserId,
        ...(student && { studentName: student.name }),
        status: 'skipped',
        reason,
        ...(accountId ? { accountId } : {}),
      });
    if (!student) {
      skip('No student record');
      continue;
    }
    if (allowedBranchIds !== null && !allowedBranchIds.includes(student.branchId)) {
      skip("The student's branch is outside your access");
      continue;
    }
    if (structure.branchId !== null && structure.branchId !== student.branchId) {
      skip("The fee structure is for another branch than the student's");
      continue;
    }
    const sourceRef = batchSourceRef(t.batchId, structure, student.id);
    const existing = billed.get(sourceRef);
    if (existing) {
      skip('Already billed for this batch', existing);
      continue;
    }
    const account = await insertAccount(
      student,
      structure,
      schedule,
      { source: 'promotion', sourceRef, batchId: t.batchId },
      transaction,
    );
    billed.set(sourceRef, account.id);
    results.push({ studentUserId, studentName: student.name, status: 'created', accountId: account.id });
  }
  return results;
}

/** Registered with academics (`setPromotionFeeProvider`) from `registerFeesIntegrations`. */
export const promotionFeeProvider: PromotionFeeProvider = {
  async options(t) {
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'fees')))
      return { available: false, defaultStructureId: null, structures: [] };
    const structures = await applicableStructures(t);
    return {
      available: true,
      defaultStructureId: structures[0]?.id ?? null,
      structures: structures.map(toOption),
    };
  },

  async prepare(t, choice: PromotionFeeRequest): Promise<PromotionFeePlan> {
    await assertFeesEnabled();
    const structure = await chooseStructure(t, choice.structureId);
    const plan: InstalmentPlan = choice.firstDueDate
      ? { ...structure.instalmentPlan, firstDueDate: choice.firstDueDate }
      : structure.instalmentPlan;
    // Invalid plans fail here, before the promotion changes anything.
    const schedule = buildSchedule(structure.total, plan, await today());
    return {
      structureId: structure.id,
      structureName: structure.name,
      apply: (studentUserIds, transaction) =>
        billStudents(t, structure, schedule, studentUserIds, transaction),
      afterCommit: (summary, fromBatchId) =>
        auditFee({
          action: 'fees.account.generate-promotion',
          entityType: 'batch',
          entityId: t.batchId,
          metadata: {
            fromBatchId,
            structureId: summary.structureId,
            created: summary.created,
            skipped: summary.skipped,
            // IDs identify the students; names stay out of the audit trail.
            results: summary.results.map(({ studentName: _name, ...r }) => r),
          },
        }),
    };
  },
};
