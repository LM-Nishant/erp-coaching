import { Op, type Transaction, type WhereOptions } from 'sequelize';
import type { ClassChangedJobPayload } from '@erp/shared';
import { ACADEMICS_CLASS_CHANGED_JOB } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { guardiansOfStudentUsers, notify } from '../notifications/api';
import { getContext, hasPermission, requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { Role, UserRole } from '../permissions/models';
import { memberVisibilityWhere } from '../permissions/access.service';
import { User } from '../users/user.model';
import { Branch } from '../branches/branch.model';
import {
  AcademicSession,
  Batch,
  BatchStudent,
  BatchTeacher,
  Chapter,
  ClassNote,
  ClassNoteAttachment,
  ClassNoteComment,
  ClassSchedule,
  ClassSession,
  Classroom,
  Course,
  CourseBranch,
  CourseCategory,
  CourseSubject,
  StudentPromotion,
  Subject,
  Topic,
} from './models';

export const repos = {
  sessions: new TenantRepository(AcademicSession, { entity: 'Academic session' }),
  categories: new TenantRepository(CourseCategory, { entity: 'Course category' }),
  courses: new TenantRepository(Course, { entity: 'Course' }),
  courseBranches: new TenantRepository(CourseBranch, { entity: 'Course branch' }),
  subjects: new TenantRepository(Subject, { entity: 'Subject' }),
  courseSubjects: new TenantRepository(CourseSubject, { entity: 'Course subject' }),
  chapters: new TenantRepository(Chapter, { entity: 'Chapter' }),
  topics: new TenantRepository(Topic, { entity: 'Topic' }),
  batches: new TenantRepository(Batch, { entity: 'Batch', branchScoped: true }),
  batchTeachers: new TenantRepository(BatchTeacher, { entity: 'Batch teacher' }),
  batchStudents: new TenantRepository(BatchStudent, { entity: 'Enrollment' }),
  promotions: new TenantRepository(StudentPromotion, { entity: 'Promotion' }),
  classrooms: new TenantRepository(Classroom, { entity: 'Classroom', branchScoped: true }),
  schedules: new TenantRepository(ClassSchedule, { entity: 'Schedule', branchScoped: true }),
  classSessions: new TenantRepository(ClassSession, { entity: 'Class session', branchScoped: true }),
  notes: new TenantRepository(ClassNote, { entity: 'Class note' }),
  noteAttachments: new TenantRepository(ClassNoteAttachment, { entity: 'Attachment' }),
  noteComments: new TenantRepository(ClassNoteComment, { entity: 'Comment' }),
};

/* ------------------------------------------------------------------ helpers */

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function assertTimeRange(start: string, end: string) {
  if (toMinutes(end) <= toMinutes(start)) throw BadRequest('End time must be after start time');
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD dates between two dates (UTC arithmetic, no TZ drift). */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export const dayOfWeek = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The branch must belong to the current institute (404 otherwise) and be allowed for the user. */
export async function assertBranch(branchId: number) {
  const { instituteId, allowedBranchIds } = requireTenantContext();
  const branch = await Branch.findOne({ where: { instituteId, id: branchId } });
  if (!branch) throw NotFound('Branch');
  if (allowedBranchIds !== null && !allowedBranchIds.includes(branchId))
    throw Forbidden('You do not have access to this branch', 'BRANCH_FORBIDDEN');
  return branch;
}

/** Returns the subset of `userIds` holding the given system role in the current institute. */
export async function usersWithRole(
  userIds: number[],
  roleSlug: string,
  transaction?: Transaction,
): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  const { instituteId } = requireTenantContext();
  const rows = await UserRole.findAll({
    where: { instituteId, userId: { [Op.in]: userIds } },
    include: [{ model: Role, as: 'role', where: { slug: roleSlug }, attributes: [] }],
    attributes: ['userId'],
    transaction,
  });
  return new Set(rows.map((r) => r.userId));
}

export async function assertTeachers(userIds: number[]) {
  const unique = [...new Set(userIds)];
  const ok = await usersWithRole(unique, 'teacher');
  const bad = unique.filter((id) => !ok.has(id));
  if (bad.length) throw BadRequest('Teachers must be users with the Teacher role', { userIds: bad });
}

export async function assertStudents(userIds: number[], transaction?: Transaction) {
  const unique = [...new Set(userIds)];
  const ok = await usersWithRole(unique, 'student', transaction);
  const bad = unique.filter((id) => !ok.has(id));
  if (bad.length) throw BadRequest('Students must be users with the Student role', { userIds: bad });
}

/** Users of the institute holding a role, for pickers. */
export async function listUsersWithRole(roleSlug: string, search?: string) {
  const { instituteId } = requireTenantContext();
  const match = search
    ? { [Op.or]: [{ name: { [Op.like]: `%${search}%` } }, { mobile: { [Op.like]: `%${search}%` } }] }
    : undefined;
  const visible = memberVisibilityWhere();
  const users = await User.findAll({
    attributes: ['id', 'name', 'mobile'],
    where: match && visible ? { [Op.and]: [match, visible] } : (match ?? visible),
    // Keeps the role filter in the join (a LIMIT subquery cannot see the nested role include).
    subQuery: false,
    include: [
      {
        model: UserRole,
        as: 'roleAssignments',
        where: { instituteId },
        attributes: ['branchId'],
        include: [{ model: Role, as: 'role', where: { slug: roleSlug }, attributes: [] }],
      },
    ],
    order: [['name', 'ASC']],
    limit: 500,
  });
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    branchIds: ((u as unknown as { roleAssignments: UserRole[] }).roleAssignments ?? [])
      .map((a) => a.branchId)
      .filter((b): b is number => b !== null),
  }));
}

/**
 * Serialises scheduling writes per institute by locking the institute row until commit, so the
 * double-booking check and the insert/update are atomic even under concurrent requests.
 */
export async function withSchedulingLock<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
  const { instituteId } = requireTenantContext();
  return getSequelize().transaction(async (t) => {
    await getSequelize().query('SELECT id FROM institutes WHERE id = ? FOR UPDATE', {
      replacements: [instituteId],
      transaction: t,
    });
    return fn(t);
  });
}

/* ------------------------------------------------------ double-booking checks */

interface Slot {
  date: string;
  startTime: string;
  endTime: string;
  teacherUserId: number;
  classroomId: number | null;
  batchId: number;
}

async function isPhysicalRoom(classroomId: number | null, t?: Transaction) {
  if (!classroomId) return false;
  const { instituteId } = requireTenantContext();
  const room = await Classroom.findOne({ where: { instituteId, id: classroomId }, transaction: t });
  return !!room && !room.isVirtual;
}

/**
 * Finds a non-cancelled class session that overlaps `slot` and shares its teacher, physical
 * classroom or batch. Checks across all branches of the institute (teachers can work in several).
 */
export async function findSessionConflict(slot: Slot, excludeId?: number, t?: Transaction) {
  const { instituteId } = requireTenantContext();
  const who: WhereOptions[] = [{ teacherUserId: slot.teacherUserId }, { batchId: slot.batchId }];
  if (await isPhysicalRoom(slot.classroomId, t)) who.push({ classroomId: slot.classroomId });
  const conflict = await ClassSession.findOne({
    where: {
      instituteId,
      date: slot.date,
      status: { [Op.ne]: 'cancelled' },
      startTime: { [Op.lt]: slot.endTime },
      endTime: { [Op.gt]: slot.startTime },
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      [Op.or]: who,
    } as WhereOptions<ClassSession>,
    transaction: t,
  });
  if (!conflict) return null;
  const reason =
    conflict.teacherUserId === slot.teacherUserId
      ? 'Teacher is already booked at this time'
      : conflict.batchId === slot.batchId
        ? 'Batch already has a class at this time'
        : 'Classroom is already booked at this time';
  return { conflict, reason };
}

export async function assertNoSessionConflict(slot: Slot, excludeId?: number, t?: Transaction) {
  const found = await findSessionConflict(slot, excludeId, t);
  if (found)
    throw Conflict(found.reason, 'DOUBLE_BOOKING', {
      classSessionId: found.conflict.id,
      date: found.conflict.date,
      startTime: found.conflict.startTime,
      endTime: found.conflict.endTime,
    });
}

interface ScheduleSlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  teacherUserId: number;
  classroomId: number | null;
  batchId: number;
}

export async function assertNoScheduleConflict(slot: ScheduleSlot, excludeId?: number, t?: Transaction) {
  const { instituteId } = requireTenantContext();
  const who: WhereOptions[] = [{ teacherUserId: slot.teacherUserId }, { batchId: slot.batchId }];
  if (await isPhysicalRoom(slot.classroomId, t)) who.push({ classroomId: slot.classroomId });
  const conflict = await ClassSchedule.findOne({
    where: {
      instituteId,
      dayOfWeek: slot.dayOfWeek,
      startTime: { [Op.lt]: slot.endTime },
      endTime: { [Op.gt]: slot.startTime },
      ...(slot.effectiveTo ? { effectiveFrom: { [Op.lte]: slot.effectiveTo } } : {}),
      [Op.and]: [
        { [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: slot.effectiveFrom } }] },
        { [Op.or]: who },
      ],
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    } as WhereOptions<ClassSchedule>,
    transaction: t,
  });
  if (!conflict) return;
  const reason =
    conflict.teacherUserId === slot.teacherUserId
      ? 'Teacher already has a recurring class at this time'
      : conflict.batchId === slot.batchId
        ? 'Batch already has a recurring class at this time'
        : 'Classroom already has a recurring class at this time';
  throw Conflict(reason, 'DOUBLE_BOOKING', { scheduleId: conflict.id });
}

/** Room must fit the batch's currently enrolled students (or its capacity when none enrolled yet). */
export async function assertRoomFitsBatch(classroomId: number | null, batch: Batch, t?: Transaction) {
  if (!classroomId) return;
  const room = await repos.classrooms.findById(classroomId, { transaction: t });
  if (room.branchId !== batch.branchId && !room.isVirtual)
    throw BadRequest('Classroom belongs to a different branch than the batch');
  if (room.status !== 'active') throw BadRequest('Classroom is inactive');
  if (room.isVirtual) return;
  const enrolled = await repos.batchStudents.count({ batchId: batch.id, status: 'active' });
  const needed = enrolled || batch.capacity;
  if (room.capacity < needed)
    throw Conflict(`Classroom capacity ${room.capacity} is below batch size ${needed}`, 'ROOM_TOO_SMALL');
}

/* ---------------------------------------------------------- session generation */

export async function generateSessions(input: { from: string; to: string; batchId?: number }) {
  if (input.to < input.from) throw BadRequest('"to" must be on or after "from"');
  if (eachDate(input.from, input.to).length > 366) throw BadRequest('Range is limited to 366 days');
  const schedules = await repos.schedules.findAll({
    where: {
      ...(input.batchId ? { batchId: input.batchId } : {}),
      effectiveFrom: { [Op.lte]: input.to },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: input.from } }],
    },
  });
  const result = {
    created: 0,
    skippedExisting: 0,
    conflicts: [] as { scheduleId: number; date: string; reason: string }[],
  };
  const { instituteId } = requireTenantContext();
  await withSchedulingLock(async (t) => {
    for (const s of schedules) {
      const batch = await Batch.findOne({ where: { instituteId, id: s.batchId }, transaction: t });
      if (!batch || batch.status === 'cancelled' || batch.status === 'completed') continue;
      const from = [input.from, s.effectiveFrom, batch.startDate].sort().at(-1)!;
      const to = [input.to, s.effectiveTo ?? input.to, batch.endDate ?? input.to].sort()[0];
      if (to < from) continue;
      const existing = new Set(
        (
          await ClassSession.findAll({
            where: { instituteId, scheduleId: s.id, occurrenceDate: { [Op.between]: [from, to] } },
            attributes: ['occurrenceDate'],
            transaction: t,
          })
        ).map((c) => c.occurrenceDate),
      );
      for (const date of eachDate(from, to)) {
        if (dayOfWeek(date) !== s.dayOfWeek) continue;
        if (existing.has(date)) {
          result.skippedExisting++;
          continue;
        }
        const slot = {
          date,
          startTime: s.startTime,
          endTime: s.endTime,
          teacherUserId: s.teacherUserId,
          classroomId: s.classroomId,
          batchId: s.batchId,
        };
        const found = await findSessionConflict(slot, undefined, t);
        if (found) {
          result.conflicts.push({ scheduleId: s.id, date, reason: found.reason });
          continue;
        }
        await ClassSession.create(
          {
            instituteId,
            branchId: s.branchId,
            batchId: s.batchId,
            subjectId: s.subjectId,
            scheduleId: s.id,
            teacherUserId: s.teacherUserId,
            classroomId: s.classroomId,
            occurrenceDate: date,
            date,
            startTime: s.startTime,
            endTime: s.endTime,
          },
          { transaction: t },
        );
        result.created++;
      }
    }
  });
  return result;
}

/* ------------------------------------------------------------- access checks */

/** Staff with `academics.edit` in its branch, the (substituted) teacher, or a student ever enrolled in the batch. */
export async function canAccessClassSession(session: ClassSession): Promise<boolean> {
  const { userId, allowedBranchIds } = getContext();
  if (
    hasPermission('academics.edit') &&
    (allowedBranchIds == null || allowedBranchIds.includes(session.branchId))
  )
    return true;
  if (!userId) return false;
  if (session.teacherUserId === userId || session.originalTeacherUserId === userId) return true;
  return (await repos.batchStudents.count({ batchId: session.batchId, studentUserId: userId })) > 0;
}

export async function assertCanAccessClassSession(session: ClassSession) {
  if (!(await canAccessClassSession(session))) throw NotFound('Class session');
}

/** Only staff with `academics.edit` or the session's teacher may post notes or record completion. */
export function assertTeacherOrStaff(session: ClassSession) {
  if (hasPermission('academics.edit')) return;
  if (session.teacherUserId !== getContext().userId)
    throw Forbidden('Only the class teacher can do this', 'NOT_CLASS_TEACHER');
}

/* ---------------------------------------------------------------- notifications */

/** Active students and assigned teachers of a batch in the current tenant (deduplicated). */
export async function getBatchMemberUserIds(
  batchId: number,
  opts: { students?: boolean; teachers?: boolean } = {},
): Promise<number[]> {
  const { students = true, teachers = true } = opts;
  const ids = new Set<number>();
  if (students) {
    const rows = await repos.batchStudents.findAll({
      where: { batchId, status: 'active' },
      attributes: ['studentUserId'],
    });
    rows.forEach((r) => ids.add(r.studentUserId));
  }
  if (teachers) {
    const rows = await repos.batchTeachers.findAll({ where: { batchId }, attributes: ['teacherUserId'] });
    rows.forEach((r) => ids.add(r.teacherUserId));
  }
  return [...ids];
}

/**
 * Enrolls student users in a batch (the single place that writes `batch_students`). Skips students
 * already actively enrolled, enforces capacity under a row lock on the batch, and joins the caller's
 * transaction when given (e.g. admissions enrolling inside the admit transaction). Callers audit.
 */
export async function enrollStudentsInBatch(
  batchId: number,
  studentUserIds: number[],
  opts: { joinedOn?: string; branchId?: number; transaction?: Transaction } = {},
): Promise<{ enrolled: number[]; skipped: number[] }> {
  const run = async (transaction: Transaction) => {
    const batch = await repos.batches.findById(batchId, { transaction, lock: transaction.LOCK.UPDATE });
    if (batch.status === 'cancelled' || batch.status === 'completed')
      throw BadRequest(`Batch is ${batch.status}`);
    if (opts.branchId !== undefined && batch.branchId !== opts.branchId)
      throw BadRequest('The batch belongs to a different branch', { batchId, branchId: batch.branchId });
    const unique = [...new Set(studentUserIds)];
    await assertStudents(unique, transaction);
    const already = new Set(
      (
        await repos.batchStudents.findAll({
          where: { batchId, status: 'active' },
          attributes: ['studentUserId'],
          transaction,
        })
      ).map((e) => e.studentUserId),
    );
    const toAdd = unique.filter((s) => !already.has(s));
    if (already.size + toAdd.length > batch.capacity)
      throw Conflict(`Batch capacity ${batch.capacity} exceeded (${already.size} enrolled)`, 'BATCH_FULL');
    for (const studentUserId of toAdd)
      await repos.batchStudents.create(
        { batchId, studentUserId, joinedOn: opts.joinedOn ?? today(), leftOn: null, promotedFromId: null },
        { transaction },
      );
    return { enrolled: toAdd, skipped: unique.filter((s) => already.has(s)) };
  };
  return opts.transaction ? run(opts.transaction) : getSequelize().transaction(run);
}

export async function notifyClassChanged(payload: ClassChangedJobPayload) {
  await enqueueJob(ACADEMICS_CLASS_CHANGED_JOB, { ...payload });
}

/**
 * Job handler: notifies the class's teacher(s) (plain users, always), its active students and their
 * guardians through the platform `notify()` API, so institute rules, templates, channels and
 * preferences apply.
 */
export async function handleClassChanged(payload: ClassChangedJobPayload) {
  const session = await repos.classSessions.findOne({
    where: { id: payload.classSessionId },
    include: [
      { model: Batch, as: 'batch', attributes: ['id', 'name'] },
      { model: Subject, as: 'subject', attributes: ['id', 'name'] },
    ],
  });
  if (!session) return;
  const students = await getBatchMemberUserIds(session.batchId, { teachers: false });
  const teachers = [session.teacherUserId, session.originalTeacherUserId].filter((id): id is number => !!id);
  const common = {
    subject: session.subject?.name ?? 'Class',
    batch: session.batch?.name ?? '',
    classSessionId: session.id,
    change: payload.change,
    reason: session.cancelReason ?? undefined,
  };
  const slot = `${session.date} ${session.startTime}-${session.endTime}`;
  let event: string;
  let data: Record<string, unknown>;
  if (payload.change === 'rescheduled') {
    event = 'classes.rescheduled';
    data = { ...common, from: session.rescheduledFrom ?? '', to: slot };
  } else if (payload.change === 'cancelled') {
    event = 'classes.cancelled';
    data = { ...common, date: slot };
  } else {
    const teacher = await User.findByPk(session.teacherUserId, { attributes: ['name'] });
    event = 'classes.substituted';
    data = { ...common, date: slot, teacher: teacher?.name ?? 'a substitute teacher' };
  }
  await notify({
    event,
    branchId: session.branchId,
    data,
    recipients: [
      { userIds: students, type: 'student' },
      guardiansOfStudentUsers(students),
      { userIds: teachers },
    ],
  });
}
