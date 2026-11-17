import { Op, type WhereOptions } from 'sequelize';
import {
  PARENT_MONTHLY_REPORT_EVENT,
  PARENT_MONTHLY_REPORT_JOB,
  type ParentChildDto,
  type ParentMonthlyReportDto,
  type ParentPortalSectionDto,
  type ParentTimetableDto,
} from '@erp/shared';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { Job } from '../../infrastructure/jobs/job.model';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext, runWithContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { BadRequest, Forbidden } from '../../shared/errors';
import { User } from '../users/user.model';
import { Branch } from '../branches/branch.model';
import { Institute } from '../institutes/institute.model';
import { Student } from '../students/models';
import { StudentGuardian } from '../guardians/models';
import { assertGuardianOf, linkedStudentIds } from '../guardians/guardian-access';
import { Batch, BatchStudent, ClassSession, Subject } from '../academics/api';
import { guardiansOf, notify } from '../notifications/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { listParentPortalProviders, type ParentReportPeriod } from './api';
import { ParentMonthlyReport } from './parent-portal.models';

export const MODULE = 'parent-portal';
export const MONTHLY_SWEEP_JOB = 'parent-portal.monthly-sweep';
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_TIMETABLE_DAYS = 62;

const reportRepo = new TenantRepository(ParentMonthlyReport, { entity: 'Report', branchScoped: true });

// ---------------------------------------------------------------- children

/** Builds the widget/provider child DTOs for the given students of the current institute. */
export async function childrenDtos(studentIds: number[]): Promise<ParentChildDto[]> {
  if (!studentIds.length) return [];
  const { instituteId } = requireTenantContext();
  const students = await Student.findAll({
    where: { instituteId, id: { [Op.in]: studentIds } },
    order: [['name', 'ASC']],
  });
  const branchIds = [...new Set(students.map((s) => s.branchId))];
  const userIds = students.map((s) => s.userId).filter((x): x is number => !!x);
  const [branches, enrolments] = await Promise.all([
    Branch.findAll({ where: { instituteId, id: { [Op.in]: branchIds } }, attributes: ['id', 'name'] }),
    userIds.length
      ? BatchStudent.findAll({
          where: { instituteId, studentUserId: { [Op.in]: userIds }, status: 'active' },
          attributes: ['batchId', 'studentUserId'],
        })
      : Promise.resolve([] as BatchStudent[]),
  ]);
  const batches = enrolments.length
    ? await Batch.findAll({
        where: { instituteId, id: { [Op.in]: [...new Set(enrolments.map((e) => e.batchId))] } },
        attributes: ['id', 'name'],
      })
    : [];
  const batchName = new Map(batches.map((b) => [b.id, b.name]));
  return students.map((s) => ({
    studentId: s.id,
    studentUserId: s.userId ?? null,
    name: s.name,
    admissionNumber: s.admissionNumber ?? null,
    branchId: s.branchId,
    branchName: branches.find((b) => b.id === s.branchId)?.name ?? null,
    batches: enrolments
      .filter((e) => e.studentUserId === s.userId)
      .map((e) => ({ id: e.batchId, name: batchName.get(e.batchId) ?? '' })),
  }));
}

/** The signed-in parent's actively linked children. */
export async function myChildren(): Promise<ParentChildDto[]> {
  return childrenDtos(await linkedStudentIds());
}

/** One linked child of the signed-in parent; 404 for anyone else's child. */
export async function myChild(studentId: number): Promise<ParentChildDto> {
  await assertGuardianOf(studentId);
  const [child] = await childrenDtos([studentId]);
  return child;
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function childTimetable(
  studentId: number,
  q: { from?: string; to?: string },
): Promise<ParentTimetableDto> {
  const child = await myChild(studentId);
  const from = q.from ?? today();
  const to = q.to ?? addDays(from, 6);
  if (to < from) throw BadRequest('to must be on or after from');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_TIMETABLE_DAYS)
    throw BadRequest(`The range may span at most ${MAX_TIMETABLE_DAYS} days`);
  if (!child.batches.length) return { from, to, items: [] };
  const { instituteId } = requireTenantContext();
  const rows = await ClassSession.findAll({
    where: {
      instituteId,
      batchId: { [Op.in]: child.batches.map((b) => b.id) },
      date: { [Op.between]: [from, to] },
    } as WhereOptions<ClassSession>,
    include: [
      { model: Batch, as: 'batch', attributes: ['id', 'name'] },
      { model: Subject, as: 'subject', attributes: ['id', 'name'] },
      { model: User, as: 'teacher', attributes: ['id', 'name'] },
    ],
    order: [
      ['date', 'ASC'],
      ['startTime', 'ASC'],
    ],
    limit: 500,
  });
  type WithRefs = ClassSession & {
    batch?: { name: string } | null;
    subject?: { name: string } | null;
    teacher?: { name: string } | null;
  };
  return {
    from,
    to,
    items: (rows as WithRefs[]).map((s) => ({
      classSessionId: s.id,
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      batchId: s.batchId,
      batchName: s.batch?.name ?? null,
      subject: s.subject?.name ?? null,
      teacher: s.teacher?.name ?? null,
    })),
  };
}

// ---------------------------------------------------------------- providers

async function enabledProviders(instituteId: number) {
  const out = [];
  for (const p of listParentPortalProviders()) {
    const mod = p.module === undefined ? p.key : p.module;
    if (mod === null || (await isModuleEnabled(instituteId, mod))) out.push(p);
  }
  return out;
}

async function collect(
  run: (
    p: Awaited<ReturnType<typeof enabledProviders>>[number],
  ) => Promise<ParentPortalSectionDto | null> | undefined,
): Promise<ParentPortalSectionDto[]> {
  const { instituteId } = requireTenantContext();
  const sections: ParentPortalSectionDto[] = [];
  for (const p of await enabledProviders(instituteId)) {
    try {
      const s = await run(p);
      if (s) sections.push({ ...s, key: s.key || p.key, label: s.label || p.label });
    } catch (err) {
      logger.warn({ provider: p.key, err }, 'Parent portal provider failed');
    }
  }
  return sections;
}

/** Live sections from every registered provider for one linked child. */
export async function childSummary(studentId: number): Promise<ParentPortalSectionDto[]> {
  const child = await myChild(studentId);
  return collect((p) => p.summary?.(child));
}

// ---------------------------------------------------------------- monthly reports

export const periodRange = (period: string): ParentReportPeriod => {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { period, from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
};

export const previousPeriod = (now = new Date()) => {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function reportDto(r: ParentMonthlyReport): ParentMonthlyReportDto {
  return {
    id: r.id,
    studentId: r.studentId,
    studentName: r.student?.name ?? null,
    period: r.period,
    sections: r.sections,
    generatedAt: r.generatedAt.toISOString(),
  };
}

export async function childReports(studentId: number): Promise<ParentMonthlyReportDto[]> {
  await myChild(studentId);
  const { instituteId } = requireTenantContext();
  const rows = await ParentMonthlyReport.findAll({
    where: { instituteId, studentId },
    include: [{ model: Student, as: 'student', attributes: ['id', 'name'] }],
    order: [['period', 'DESC']],
    limit: 24,
  });
  return rows.map(reportDto);
}

/** Staff view of generated reports (branch-scoped). */
export async function listReports(q: {
  period?: string;
  studentId?: number;
  page: number;
  pageSize: number;
}) {
  const where: Record<string, unknown> = {};
  if (q.period) where.period = q.period;
  if (q.studentId) where.studentId = q.studentId;
  const { rows, count } = await reportRepo.findAndCountAll({
    where,
    include: [{ model: Student, as: 'student', attributes: ['id', 'name'] }],
    order: [
      ['period', 'DESC'],
      ['id', 'ASC'],
    ],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  return { items: rows.map(reportDto), total: count, page: q.page, pageSize: q.pageSize };
}

/** Staff trigger; the work runs in the background job. */
export async function requestGeneration(input: { period?: string; studentIds?: number[] }) {
  const { instituteId, allowedBranchIds } = requireTenantContext();
  const period = input.period ?? previousPeriod();
  if (period > today().slice(0, 7)) throw BadRequest('The period cannot be in the future');
  if (allowedBranchIds !== null) {
    // Branch-limited staff may only generate for students of their branches.
    if (!input.studentIds?.length) throw Forbidden('Pick students of your branches', 'BRANCH_FORBIDDEN');
    const n = await Student.count({
      where: { instituteId, id: { [Op.in]: input.studentIds }, branchId: { [Op.in]: allowedBranchIds } },
    });
    if (n !== new Set(input.studentIds).size)
      throw Forbidden('Pick students of your branches', 'BRANCH_FORBIDDEN');
  }
  const job = await enqueueJob(PARENT_MONTHLY_REPORT_JOB, { period, studentIds: input.studentIds ?? null });
  await audit({
    action: 'parent-portal.monthly-report.generate',
    entityType: 'Job',
    entityId: job.id,
    metadata: { period, studentIds: input.studentIds ?? null },
  });
  return { jobId: job.id, period };
}

/**
 * `parent-portal.monthly-report` job (institute context): aggregates every provider's `monthlyReport`
 * for each actively-linked child, stores/replaces the report and notifies the guardians.
 */
export async function runMonthlyReport(payload: { period?: string; studentIds?: number[] | null }) {
  const { instituteId } = requireTenantContext();
  const period = payload.period ?? previousPeriod();
  const range = periodRange(period);
  const linkWhere: Record<string, unknown> = { instituteId, status: 'active' };
  if (payload.studentIds?.length) linkWhere.studentId = { [Op.in]: payload.studentIds };
  const links = await StudentGuardian.findAll({ where: linkWhere, attributes: ['studentId'] });
  const studentIds = [...new Set(links.map((l) => l.studentId))];
  const children = await childrenDtos(studentIds);
  let generated = 0;
  for (const child of children) {
    const sections = await collect((p) => p.monthlyReport?.(child, range));
    const existing = await ParentMonthlyReport.findOne({
      where: { instituteId, studentId: child.studentId, period },
    });
    if (existing) await existing.update({ sections, generatedAt: new Date(), branchId: child.branchId });
    else
      await ParentMonthlyReport.create({
        instituteId,
        branchId: child.branchId,
        studentId: child.studentId,
        period,
        sections,
        generatedAt: new Date(),
      });
    await notify({
      event: PARENT_MONTHLY_REPORT_EVENT,
      recipients: [guardiansOf(child.studentId)],
      data: { student: child.name, period },
      branchId: child.branchId,
    });
    generated++;
  }
  return generated;
}

/**
 * Daily system sweep: for every active institute that has no reports for last month yet, queue the
 * monthly report job. Re-enqueues itself.
 */
export async function runMonthlySweep() {
  try {
    const period = previousPeriod();
    // System job across institutes: each one is then handled in its own tenant context.
    const institutes = await Institute.findAll({ where: { status: 'active' }, attributes: ['id'] });
    for (const inst of institutes) {
      await runWithContext({ system: true, instituteId: inst.id, allowedBranchIds: null }, async () => {
        if (!(await isModuleEnabled(inst.id, MODULE))) return;
        const done = await ParentMonthlyReport.count({ where: { instituteId: inst.id, period } });
        const queued = await Job.count({
          where: {
            name: PARENT_MONTHLY_REPORT_JOB,
            instituteId: inst.id,
            status: { [Op.in]: ['pending', 'running'] },
          },
        });
        if (!done && !queued)
          await enqueueJob(PARENT_MONTHLY_REPORT_JOB, { period }, { instituteId: inst.id });
      });
    }
  } finally {
    await scheduleMonthlySweep();
  }
}

export async function scheduleMonthlySweep() {
  const pending = await Job.findOne({ where: { name: MONTHLY_SWEEP_JOB, status: 'pending' } });
  if (pending) return;
  await enqueueJob(
    MONTHLY_SWEEP_JOB,
    {},
    { instituteId: null, runAt: new Date(Date.now() + SWEEP_INTERVAL_MS) },
  );
}
