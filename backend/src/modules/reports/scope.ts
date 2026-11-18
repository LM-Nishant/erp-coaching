import { Op } from 'sequelize';
import {
  REPORT_DATE_PRESETS,
  REPORT_DATE_PRESET_LABELS,
  SYSTEM_ROLES,
  type ReportAppliedFiltersDto,
  type ReportAudience,
  type ReportFilterOptionsDto,
  type ReportFiltersInput,
  type ReportPeriodDto,
} from '@erp/shared';
import { requireTenantContext, type RequestContext } from '../../shared/context';
import { BadRequest, Forbidden, NotFound } from '../../shared/errors';
import type { ReportScope } from '../../shared/reporting';
import { getInstituteTimezone, todayIn } from '../../shared/timezone';
import { Batch, BatchTeacher, Course } from '../academics/api';
import { Branch } from '../branches/branch.model';
import { getLinkedStudents, getLinkedStudentUsers } from '../guardians/guardian-access';
import { studentRecordsForUsers } from '../students/api';
import { DEFAULT_REPORT_PRESET, periodDto, resolvePeriod } from './filters';

/** A report request resolved from the caller's context and filters, after every access check. */
export interface ResolvedReportRequest {
  audience: ReportAudience;
  scope: ReportScope;
  period: ReportPeriodDto;
  filters: ReportAppliedFiltersDto;
  scopeLabel: string;
  /** Optional data sources the caller may see (checked at request time, reused by export jobs). */
  sources: string[];
}

/** JSON form stored with an export (instants as ISO strings). */
export type StoredReportRequest = Omit<ResolvedReportRequest, 'scope'> & {
  scope: Omit<ReportScope, 'start' | 'end'> & { start: string; end: string };
};

export const toStoredRequest = (r: ResolvedReportRequest): StoredReportRequest => ({
  ...r,
  scope: { ...r.scope, start: r.scope.start.toISOString(), end: r.scope.end.toISOString() },
});

export const fromStoredRequest = (s: StoredReportRequest): ResolvedReportRequest => ({
  ...s,
  scope: { ...s.scope, start: new Date(s.scope.start), end: new Date(s.scope.end) },
});

/**
 * Whose data the caller sees. Admin roles see their branches; accountants the finance reports;
 * teachers their own batches and classes; students themselves; parents their linked children.
 * Custom roles are treated as management and limited by branch access and source permissions.
 */
export function resolveAudience(ctx: RequestContext): ReportAudience {
  if (ctx.isSuperAdmin && !ctx.impersonatorId) return 'management';
  const roles = new Set(ctx.roles ?? []);
  if (roles.has(SYSTEM_ROLES.INSTITUTE_ADMIN) || roles.has(SYSTEM_ROLES.BRANCH_ADMIN)) return 'management';
  if (roles.has(SYSTEM_ROLES.ACCOUNTANT)) return 'finance';
  if (roles.has(SYSTEM_ROLES.TEACHER)) return 'teacher';
  if (roles.has(SYSTEM_ROLES.PARENT)) return 'parent';
  if (roles.has(SYSTEM_ROLES.STUDENT)) return 'student';
  return 'management';
}

/** Branches the caller may report on: the `X-Branch-Id` branch, else every allowed branch (null = all). */
export const effectiveBranchIds = (ctx: RequestContext): number[] | null =>
  ctx.activeBranchId ? [ctx.activeBranchId] : (ctx.allowedBranchIds ?? null);

const isPersonal = (audience: ReportAudience) => audience === 'student' || audience === 'parent';

async function teacherBatches(instituteId: number, teacherUserId: number, branchIds: number[] | null) {
  const links = await BatchTeacher.findAll({
    where: { instituteId, teacherUserId },
    attributes: ['batchId'],
  });
  const ids = [...new Set(links.map((l) => l.batchId))];
  if (!ids.length) return [];
  return Batch.findAll({
    where: { instituteId, id: { [Op.in]: ids }, ...(branchIds ? { branchId: { [Op.in]: branchIds } } : {}) },
    attributes: ['id', 'name', 'branchId', 'courseId', 'status'],
    order: [['name', 'ASC']],
  });
}

/**
 * Resolves the caller's report scope: audience, period (institute timezone) and validated branch,
 * course and batch filters. Client-supplied institute ids are never read; foreign ids are 404 and
 * ids outside the caller's branches or batches are 403.
 */
export async function resolveReportRequest(
  input: ReportFiltersInput,
  limit: number,
): Promise<ResolvedReportRequest> {
  const ctx = requireTenantContext();
  const { instituteId } = ctx;
  const audience = resolveAudience(ctx);
  const timezone = await getInstituteTimezone(instituteId);
  const period = resolvePeriod(input, timezone);
  const scope: ReportScope = {
    instituteId,
    branchIds: null,
    courseId: null,
    batchId: null,
    batchIds: null,
    teacherUserId: null,
    studentUserIds: null,
    studentIds: null,
    viewerUserId: ctx.userId ?? null,
    from: period.from,
    to: period.to,
    start: period.start,
    end: period.end,
    timezone,
    limit,
  };
  const filters: ReportAppliedFiltersDto = {
    branchId: null,
    branchName: null,
    courseId: null,
    courseName: null,
    batchId: null,
    batchName: null,
  };
  const result = (scopeLabel: string): ResolvedReportRequest => ({
    audience,
    scope,
    period: periodDto(period),
    filters,
    scopeLabel,
    sources: [],
  });

  if (isPersonal(audience)) {
    if (input.branchId || input.courseId || input.batchId) {
      throw BadRequest('Branch, course and batch filters are not available for your role');
    }
    const userId = ctx.userId ?? 0;
    if (audience === 'student') {
      const records = await studentRecordsForUsers(instituteId, [userId]);
      scope.studentUserIds = [userId];
      scope.studentIds = records.map((r) => r.id);
      return result('Your records');
    }
    const [children, childUsers] = await Promise.all([
      getLinkedStudents(userId, instituteId),
      getLinkedStudentUsers(userId, instituteId),
    ]);
    scope.studentIds = children.map((c) => c.id);
    scope.studentUserIds = childUsers.map((c) => c.id);
    const names = children.map((c) => c.name).join(', ');
    return result(
      children.length
        ? `${children.length === 1 ? 'Your child' : 'Your children'}: ${names}`
        : 'No linked children',
    );
  }

  scope.branchIds = effectiveBranchIds(ctx);
  const ownBatches = audience === 'teacher' ? await teacherBatches(instituteId, ctx.userId ?? 0, null) : null;
  if (ownBatches) {
    scope.batchIds = ownBatches.map((b) => b.id);
    scope.teacherUserId = ctx.userId ?? null;
  }

  if (input.branchId) {
    const branch = await Branch.findOne({ where: { id: input.branchId, instituteId } });
    if (!branch) throw NotFound('Branch');
    if (scope.branchIds && !scope.branchIds.includes(branch.id)) {
      throw Forbidden('You do not have access to this branch', 'BRANCH_FORBIDDEN');
    }
    scope.branchIds = [branch.id];
    filters.branchId = branch.id;
    filters.branchName = branch.name;
  }
  if (input.courseId) {
    const course = await Course.findOne({ where: { id: input.courseId, instituteId } });
    if (!course) throw NotFound('Course');
    if (ownBatches && !ownBatches.some((b) => b.courseId === course.id)) {
      throw Forbidden('You do not teach this course', 'COURSE_FORBIDDEN');
    }
    scope.courseId = course.id;
    filters.courseId = course.id;
    filters.courseName = course.name;
  }
  if (input.batchId) {
    const batch = await Batch.findOne({ where: { id: input.batchId, instituteId } });
    if (!batch) throw NotFound('Batch');
    if (scope.branchIds && !scope.branchIds.includes(batch.branchId)) {
      throw Forbidden('You do not have access to this batch', 'BRANCH_FORBIDDEN');
    }
    if (ownBatches && !ownBatches.some((b) => b.id === batch.id)) {
      throw Forbidden('You do not teach this batch', 'BATCH_FORBIDDEN');
    }
    if (input.courseId && batch.courseId !== input.courseId) {
      throw BadRequest('The batch does not belong to the selected course');
    }
    scope.batchId = batch.id;
    scope.courseId = batch.courseId;
    filters.batchId = batch.id;
    filters.batchName = batch.name;
  }

  let where = 'All branches';
  if (filters.branchName) where = `Branch: ${filters.branchName}`;
  else if (scope.branchIds) {
    const names = (
      await Branch.findAll({
        where: { instituteId, id: { [Op.in]: scope.branchIds } },
        attributes: ['name'],
        order: [['name', 'ASC']],
      })
    ).map((b) => b.name);
    where = names.length === 1 ? `Branch: ${names[0]}` : `Branches: ${names.join(', ') || 'none'}`;
  }
  return result(audience === 'teacher' ? `Your batches and classes · ${where}` : where);
}

/** Filter choices for the caller: periods plus the branches, courses and batches they may pick. */
export async function reportFilterOptions(): Promise<ReportFilterOptionsDto> {
  const ctx = requireTenantContext();
  const { instituteId } = ctx;
  const audience = resolveAudience(ctx);
  const timezone = await getInstituteTimezone(instituteId);
  const base = {
    timezone,
    today: todayIn(timezone),
    presets: REPORT_DATE_PRESETS.map((value) => ({ value, label: REPORT_DATE_PRESET_LABELS[value] })),
    defaultPreset: DEFAULT_REPORT_PRESET,
    audience,
  };
  if (isPersonal(audience)) return { ...base, branches: [], courses: [], batches: [] };

  const branchIds = effectiveBranchIds(ctx);
  const branchWhere = branchIds ? { branchId: { [Op.in]: branchIds } } : {};
  const batches =
    audience === 'teacher'
      ? (await teacherBatches(instituteId, ctx.userId ?? 0, branchIds)).filter(
          (b) => b.status !== 'cancelled',
        )
      : await Batch.findAll({
          where: { instituteId, status: { [Op.ne]: 'cancelled' }, ...branchWhere },
          attributes: ['id', 'name', 'branchId', 'courseId'],
          order: [['name', 'ASC']],
        });
  const [branches, courses] = await Promise.all([
    Branch.findAll({
      where: { instituteId, ...(branchIds ? { id: { [Op.in]: branchIds } } : {}) },
      attributes: ['id', 'name'],
      order: [['name', 'ASC']],
    }),
    Course.findAll({
      where: {
        instituteId,
        isTemplate: false,
        ...(audience === 'teacher' ? { id: { [Op.in]: [...new Set(batches.map((b) => b.courseId))] } } : {}),
      },
      attributes: ['id', 'name'],
      order: [['name', 'ASC']],
    }),
  ]);
  const teachesIn = new Set(batches.map((b) => b.branchId));
  return {
    ...base,
    branches: branches
      .filter((b) => audience !== 'teacher' || teachesIn.has(b.id))
      .map((b) => ({ id: b.id, name: b.name })),
    courses: courses.map((c) => ({ id: c.id, name: c.name })),
    batches: batches.map((b) => ({ id: b.id, name: b.name, branchId: b.branchId, courseId: b.courseId })),
  };
}
