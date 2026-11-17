import { Op, type Transaction } from 'sequelize';
import type { FeeComponentLine, FeeStructureDto, InstalmentPlan } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest, Conflict } from '../../shared/errors';
import { requireTenantContext } from '../../shared/context';
import { Batch, Course, Subject } from '../academics/api';
import { FeeConcessionRule, FeeHead, FeeStructure } from './models';
import { addMonths, splitEvenly, today } from './util';

export const headRepo = new TenantRepository(FeeHead, { entity: 'Fee head' });
export const structureRepo = new TenantRepository(FeeStructure, {
  branchScoped: true,
  instituteWideRows: true,
  entity: 'Fee structure',
});
export const ruleRepo = new TenantRepository(FeeConcessionRule, { entity: 'Concession rule' });

export interface ScheduleLine {
  seq: number;
  label: string;
  dueDate: string;
  amount: number;
}

/** Splits a total into instalments according to the plan (last instalment absorbs rounding). */
export function buildSchedule(total: number, plan: InstalmentPlan, start = today()): ScheduleLine[] {
  const first = plan.firstDueDate ?? start;
  if (plan.type === 'custom') {
    const custom = plan.custom ?? [];
    if (!custom.length) throw BadRequest('Custom instalment plan needs at least one instalment');
    const pct = custom.reduce((s, c) => s + c.percent, 0);
    if (Math.abs(pct - 100) > 0.001) throw BadRequest('Custom instalment percentages must add up to 100');
    let used = 0;
    return custom.map((c, i) => {
      const amount = i === custom.length - 1 ? total - used : Math.round((total * c.percent) / 100);
      used += amount;
      return { seq: i + 1, label: c.label, dueDate: c.dueDate, amount };
    });
  }
  if (plan.type === 'one_time') return [{ seq: 1, label: 'Full fee', dueDate: first, amount: total }];
  const step = plan.type === 'monthly' ? 1 : 3;
  const count = Math.max(1, Math.min(plan.count ?? (plan.type === 'monthly' ? 12 : 4), 60));
  return splitEvenly(total, count).map((amount, i) => ({
    seq: i + 1,
    label: `Instalment ${i + 1}`,
    dueDate: addMonths(first, i * step),
    amount,
  }));
}

export function toStructureDto(s: FeeStructure): FeeStructureDto {
  return {
    id: s.id,
    branchId: s.branchId,
    kind: s.kind,
    courseId: s.courseId,
    batchId: s.batchId,
    subjectId: s.subjectId,
    academicSessionId: s.academicSessionId,
    name: s.name,
    version: s.version,
    familyId: s.familyId ?? s.id,
    status: s.status,
    effectiveFrom: s.effectiveFrom,
    components: s.components,
    total: s.total,
    instalmentPlan: s.instalmentPlan,
    createdAt: s.createdAt.toISOString(),
  };
}

export interface StructureInput {
  branchId?: number | null;
  kind: 'course' | 'subject';
  courseId?: number | null;
  batchId?: number | null;
  subjectId?: number | null;
  academicSessionId?: number | null;
  name: string;
  status?: 'draft' | 'active';
  effectiveFrom?: string;
  components: { feeHeadId?: number | null; name?: string; amount: number; taxable?: boolean }[];
  instalmentPlan: InstalmentPlan;
}

async function resolveComponents(lines: StructureInput['components']): Promise<FeeComponentLine[]> {
  const { instituteId } = requireTenantContext();
  const ids = lines.map((l) => l.feeHeadId).filter((x): x is number => !!x);
  const heads = ids.length ? await FeeHead.findAll({ where: { instituteId, id: { [Op.in]: ids } } }) : [];
  return lines.map((l) => {
    const head = l.feeHeadId ? heads.find((h) => h.id === l.feeHeadId) : undefined;
    if (l.feeHeadId && !head) throw BadRequest(`Fee head ${l.feeHeadId} not found`);
    const name = l.name?.trim() || head?.name;
    if (!name) throw BadRequest('Each component needs a fee head or a name');
    return {
      feeHeadId: head?.id ?? null,
      name,
      amount: l.amount,
      taxable: l.taxable ?? head?.taxable ?? true,
    };
  });
}

/** Validates the course/batch/subject targets belong to this institute and are consistent. */
async function resolveTargets(input: StructureInput) {
  const { instituteId } = requireTenantContext();
  let { courseId = null, branchId = null, academicSessionId = null } = input;
  const batchId = input.batchId ?? null;
  const subjectId = input.subjectId ?? null;
  if (batchId) {
    const batch = await Batch.findOne({ where: { instituteId, id: batchId } });
    if (!batch) throw BadRequest('Batch not found');
    courseId = courseId ?? batch.courseId;
    if (courseId !== batch.courseId) throw BadRequest('Batch does not belong to the course');
    branchId = branchId ?? batch.branchId;
    if (branchId !== batch.branchId) throw BadRequest('Batch does not belong to the branch');
    academicSessionId = academicSessionId ?? batch.academicSessionId ?? null;
  }
  if (courseId && !(await Course.findOne({ where: { instituteId, id: courseId }, attributes: ['id'] })))
    throw BadRequest('Course not found');
  if (subjectId && !(await Subject.findOne({ where: { instituteId, id: subjectId }, attributes: ['id'] })))
    throw BadRequest('Subject not found');
  if (input.kind === 'subject' && !subjectId) throw BadRequest('Subject fee structures need a subjectId');
  if (input.kind === 'course' && !courseId)
    throw BadRequest('Course fee structures need a courseId or batchId');
  return { courseId, batchId, subjectId, branchId, academicSessionId };
}

export async function createStructure(
  input: StructureInput,
  familyId?: number,
  version = 1,
  transaction?: Transaction,
) {
  const components = await resolveComponents(input.components);
  const total = components.reduce((s, c) => s + c.amount, 0);
  if (total <= 0) throw BadRequest('Fee structure total must be positive');
  buildSchedule(total, input.instalmentPlan);
  const targets = await resolveTargets(input);
  const row = await structureRepo.create(
    {
      ...targets,
      familyId: familyId ?? null,
      version,
      kind: input.kind,
      name: input.name,
      status: input.status ?? 'active',
      effectiveFrom: input.effectiveFrom ?? today(),
      components,
      total,
      instalmentPlan: input.instalmentPlan,
      createdByUserId: requireTenantContext().userId ?? null,
    },
    { transaction },
  );
  if (!familyId) await row.update({ familyId: row.id }, { transaction });
  return row;
}

/**
 * Session/price changes create a new version: the old version is archived (kept for history and
 * for accounts already generated from it) and the new one becomes active.
 */
export async function createStructureVersion(id: number, input: Partial<StructureInput>) {
  const current = await structureRepo.findById(id);
  structureRepo.assertRowWritable(current);
  if (current.status === 'archived') throw Conflict('Only the latest version can be revised', 'ARCHIVED');
  return getSequelize().transaction(async (transaction) => {
    const { instituteId } = requireTenantContext();
    const familyId = current.familyId ?? current.id;
    const latest = (await FeeStructure.max('version', {
      where: { instituteId, familyId },
      transaction,
    })) as number;
    const next = await createStructure(
      {
        branchId: current.branchId,
        kind: current.kind,
        courseId: current.courseId,
        batchId: current.batchId,
        subjectId: current.subjectId,
        academicSessionId: current.academicSessionId,
        name: current.name,
        components: current.components,
        instalmentPlan: current.instalmentPlan,
        ...input,
        status: 'active',
      },
      familyId,
      (latest ?? current.version) + 1,
      transaction,
    );
    await FeeStructure.update(
      { status: 'archived' },
      {
        where: { instituteId, familyId, id: { [Op.ne]: next.id }, status: { [Op.ne]: 'archived' } },
        transaction,
      },
    );
    return next;
  });
}

/** Best active structure for an enrolment: batch → course+branch → course (institute-wide). */
export async function findStructureFor(target: {
  branchId: number;
  courseId: number | null;
  batchId: number | null;
}): Promise<FeeStructure | null> {
  const { instituteId } = requireTenantContext();
  const base = { instituteId, status: 'active' as const, kind: 'course' as const };
  const order: [string, string][] = [['version', 'DESC']];
  if (target.batchId) {
    const s = await FeeStructure.findOne({ where: { ...base, batchId: target.batchId }, order });
    if (s) return s;
  }
  if (!target.courseId) return null;
  return (
    (await FeeStructure.findOne({
      where: { ...base, courseId: target.courseId, batchId: null, branchId: target.branchId },
      order,
    })) ??
    (await FeeStructure.findOne({
      where: { ...base, courseId: target.courseId, batchId: null, branchId: null },
      order,
    }))
  );
}
