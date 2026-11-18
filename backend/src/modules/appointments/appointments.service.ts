import { Op, type Transaction, type WhereOptions } from 'sequelize';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  type AppointmentDetailDto,
  type AppointmentDto,
  type AppointmentEventAction,
  type AppointmentEventDto,
  type AppointmentMode,
  type AppointmentReportSummary,
  type AppointmentSlotDto,
  type AppointmentStatus,
  type AppointmentTeacherDto,
  type AvailableSlotDto,
  type SlotKind,
  type SlotMode,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { getCalendarProvider, type CalendarEventInput } from '../../infrastructure/calendar';
import { getContext, hasPermission, requireTenantContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { getInstituteTimezone, instituteToday, zonedDateTimeToUtc } from '../../shared/timezone';
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { User } from '../users/user.model';
import { Role, UserRole } from '../permissions/models';
import { assertMemberInBranchScope } from '../permissions/access.service';
import { Branch } from '../branches/branch.model';
import { Student } from '../students/models';
import { Batch, BatchStudent, BatchTeacher, Subject } from '../academics/api';
import { assertGuardianOf, linkedStudentIds } from '../guardians/guardian-access';
import { guardiansOf, notify } from '../notifications/api';
import { Appointment, AppointmentEvent, AppointmentSlot } from './appointments.models';

export const MODULE = 'appointments';
export const REMINDER_JOB = 'appointments.reminder';
/** Reminder lead times before the meeting, in minutes. */
export const REMINDER_LEADS_MINUTES = [24 * 60, 60];
/** Longest window the availability endpoint expands. */
const MAX_AVAILABILITY_DAYS = 31;

const slotRepo = new TenantRepository(AppointmentSlot, { entity: 'Slot', branchScoped: true });
const apptRepo = new TenantRepository(Appointment, { entity: 'Appointment', branchScoped: true });

const userRef = { attributes: ['id', 'name'] };

// ---------------------------------------------------------------- time helpers

export const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const fromMinutes = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const dayOfWeek = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/**
 * Appointment dates/times are institute wall-clock values; absolute instants (reminder run times,
 * "is it in the past") are computed in the institute's timezone.
 */
export const localInstant = (date: string, time: string, tz: string) => zonedDateTimeToUtc(date, time, tz);
export const localToday = (instituteId?: number) => instituteToday(instituteId);
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd && bStart < aEnd;

// ---------------------------------------------------------------- access helpers

const me = () => {
  const { userId } = requireTenantContext();
  if (!userId) throw Forbidden();
  return userId;
};
/** Branch staff who manage every teacher's slots and appointments. */
export const isManager = () => hasPermission(`${MODULE}.configure`);
const canSeeAll = () => isManager() || hasPermission(`${MODULE}.export`);

async function usersWithRole(userIds: number[], slug: string): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  const { instituteId } = requireTenantContext();
  const rows = await UserRole.findAll({
    where: { instituteId, userId: { [Op.in]: userIds } },
    include: [{ model: Role, as: 'role', where: { slug }, attributes: [] }],
    attributes: ['userId'],
  });
  return new Set(rows.map((r) => r.userId));
}

async function assertTeacher(userId: number) {
  if (!(await usersWithRole([userId], 'teacher')).has(userId))
    throw BadRequest('The user is not a teacher of this institute');
}

/** The signed-in parent's child with its active batch ids; 404 unless actively linked. */
export async function childForParent(studentId: number) {
  await assertGuardianOf(studentId);
  const { instituteId } = requireTenantContext();
  const student = await Student.findOne({ where: { instituteId, id: studentId } });
  if (!student) throw NotFound('Student');
  const batchIds = student.userId
    ? (
        await BatchStudent.findAll({
          where: { instituteId, studentUserId: student.userId, status: 'active' },
          attributes: ['batchId'],
        })
      ).map((b) => b.batchId)
    : [];
  return { student, batchIds };
}

/** Teachers assigned to the child's active batches (the only teachers a parent may book). */
export async function teachersForChild(studentId: number): Promise<AppointmentTeacherDto[]> {
  const { batchIds } = await childForParent(studentId);
  if (!batchIds.length) return [];
  const { instituteId } = requireTenantContext();
  const links = await BatchTeacher.findAll({
    where: { instituteId, batchId: { [Op.in]: batchIds } },
    include: [{ model: User, as: 'teacher', ...userRef }],
  });
  const [batches, subjects] = await Promise.all([
    Batch.findAll({ where: { instituteId, id: { [Op.in]: batchIds } }, attributes: ['id', 'name'] }),
    Subject.findAll({
      where: { instituteId, id: { [Op.in]: links.map((l) => l.subjectId).filter((x): x is number => !!x) } },
      attributes: ['id', 'name'],
    }),
  ]);
  const batchName = new Map(batches.map((b) => [b.id, b.name]));
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  const byTeacher = new Map<number, AppointmentTeacherDto>();
  for (const l of links) {
    const t = byTeacher.get(l.teacherUserId) ?? {
      teacherUserId: l.teacherUserId,
      name: l.teacher?.name ?? '',
      batches: [],
    };
    t.batches.push({
      id: l.batchId,
      name: batchName.get(l.batchId) ?? '',
      subject: l.subjectId ? (subjectName.get(l.subjectId) ?? null) : null,
    });
    byTeacher.set(l.teacherUserId, t);
  }
  return [...byTeacher.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function assertTeachesChild(studentId: number, teacherUserId: number) {
  const teachers = await teachersForChild(studentId);
  if (!teachers.some((t) => t.teacherUserId === teacherUserId))
    throw new AppError(400, 'NOT_CHILD_TEACHER', "This teacher does not teach any of the child's batches");
}

// ---------------------------------------------------------------- DTOs

export function slotDto(s: AppointmentSlot): AppointmentSlotDto {
  return {
    id: s.id,
    branchId: s.branchId,
    teacherUserId: s.teacherUserId,
    teacherName: s.teacher?.name ?? null,
    kind: s.kind,
    dayOfWeek: s.dayOfWeek,
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    slotMinutes: s.slotMinutes,
    mode: s.mode,
    location: s.location,
    effectiveFrom: s.effectiveFrom,
    effectiveTo: s.effectiveTo,
    isActive: s.isActive,
  };
}

/** Private notes are visible to the meeting's teacher and appointment managers only. */
const canSeePrivateNotes = (a: Appointment) => a.teacherUserId === getContext().userId || isManager();

export function appointmentDto(a: Appointment): AppointmentDto {
  return {
    id: a.id,
    branchId: a.branchId,
    slotId: a.slotId,
    teacher: a.teacher ? { id: a.teacher.id, name: a.teacher.name } : null,
    requestedBy: a.requestedBy ? { id: a.requestedBy.id, name: a.requestedBy.name } : null,
    studentId: a.studentId,
    studentName: a.student?.name ?? null,
    date: a.date,
    startTime: a.startTime,
    endTime: a.endTime,
    mode: a.mode,
    status: a.status,
    agenda: a.agenda,
    location: a.location,
    meetingUrl: a.meetingUrl,
    responseNote: a.responseNote,
    cancelReason: a.cancelReason,
    rescheduleCount: a.rescheduleCount,
    sharedSummary: a.sharedSummary,
    ...(canSeePrivateNotes(a) ? { privateNotes: a.privateNotes } : {}),
    completedAt: a.completedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

function eventDto(e: AppointmentEvent): AppointmentEventDto {
  return {
    id: e.id,
    action: e.action,
    actor: e.actor ? { id: e.actor.id, name: e.actor.name } : null,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    note: e.note,
    metadata: e.metadata,
    createdAt: e.createdAt.toISOString(),
  };
}

const apptIncludes = [
  { model: User, as: 'teacher', ...userRef },
  { model: User, as: 'requestedBy', ...userRef },
  { model: Student, as: 'student', attributes: ['id', 'name'] },
];

// ---------------------------------------------------------------- slots

export interface SlotInput {
  branchId?: number;
  teacherUserId?: number;
  kind: SlotKind;
  dayOfWeek?: number | null;
  date?: string | null;
  startTime: string;
  endTime: string;
  slotMinutes?: number;
  mode?: SlotMode;
  location?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive?: boolean;
}

function validateSlotShape(s: {
  kind: SlotKind;
  dayOfWeek: number | null | undefined;
  date: string | null | undefined;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}) {
  if (s.kind === 'recurring' && (s.dayOfWeek === null || s.dayOfWeek === undefined))
    throw BadRequest('Recurring slots need a dayOfWeek');
  if (s.kind === 'one_off' && !s.date) throw BadRequest('One-off slots need a date');
  const len = toMinutes(s.endTime) - toMinutes(s.startTime);
  if (len <= 0) throw BadRequest('endTime must be after startTime');
  if (len < s.slotMinutes) throw BadRequest('The window is shorter than one meeting (slotMinutes)');
  if (s.effectiveFrom && s.effectiveTo && s.effectiveTo < s.effectiveFrom)
    throw BadRequest('effectiveTo must be on or after effectiveFrom');
}

/** Teachers manage their own slots; managers (`appointments.configure`) anyone's. */
function assertOwnsSlot(slot: AppointmentSlot) {
  if (slot.teacherUserId !== me() && !isManager()) throw NotFound('Slot');
}

export async function listSlots(q: { teacherUserId?: number; includeInactive?: boolean }) {
  const where: Record<string, unknown> = {};
  if (isManager()) {
    if (q.teacherUserId) where.teacherUserId = q.teacherUserId;
  } else where.teacherUserId = me();
  if (!q.includeInactive) where.isActive = true;
  // Teachers see their own slots across branches; managers are limited to their branches.
  const rows = isManager()
    ? await slotRepo.findAll({
        where,
        include: [{ model: User, as: 'teacher', ...userRef }],
        order: [['id', 'ASC']],
      })
    : await AppointmentSlot.findAll({
        where: { ...where, instituteId: requireTenantContext().instituteId },
        include: [{ model: User, as: 'teacher', ...userRef }],
        order: [['id', 'ASC']],
      });
  return rows.map(slotDto);
}

export async function createSlot(input: SlotInput) {
  const teacherUserId = input.teacherUserId ?? me();
  if (teacherUserId !== me() && !isManager()) throw Forbidden('You can only manage your own availability');
  await assertTeacher(teacherUserId);
  const data = {
    kind: input.kind,
    dayOfWeek: input.kind === 'recurring' ? (input.dayOfWeek ?? null) : null,
    date: input.kind === 'one_off' ? (input.date ?? null) : null,
    startTime: input.startTime,
    endTime: input.endTime,
    slotMinutes: input.slotMinutes ?? 15,
    mode: input.mode ?? 'both',
    location: input.location ?? null,
    effectiveFrom: input.kind === 'recurring' ? (input.effectiveFrom ?? null) : null,
    effectiveTo: input.kind === 'recurring' ? (input.effectiveTo ?? null) : null,
    isActive: input.isActive ?? true,
  } as const;
  validateSlotShape(data);
  if (input.branchId) await assertBranchExists(input.branchId);
  const slot = await slotRepo.create({ ...data, branchId: input.branchId as number, teacherUserId });
  await audit({
    action: 'appointments.slot.create',
    entityType: 'AppointmentSlot',
    entityId: slot.id,
    metadata: { after: slotDto(slot) },
  });
  return slotDto(slot);
}

async function assertBranchExists(branchId: number) {
  const { instituteId } = requireTenantContext();
  if (!(await Branch.findOne({ where: { instituteId, id: branchId } }))) throw NotFound('Branch');
  slotRepo.assertBranchAllowed(branchId);
}

async function loadSlot(id: number) {
  const { instituteId } = requireTenantContext();
  const slot = await AppointmentSlot.findOne({ where: { instituteId, id } });
  if (!slot) throw NotFound('Slot');
  assertOwnsSlot(slot);
  if (slot.teacherUserId !== me()) slotRepo.assertBranchAllowed(slot.branchId);
  return slot;
}

export async function updateSlot(id: number, input: Partial<SlotInput>) {
  const slot = await loadSlot(id);
  const before = slotDto(slot);
  const merged = {
    kind: input.kind ?? slot.kind,
    dayOfWeek: input.dayOfWeek !== undefined ? input.dayOfWeek : slot.dayOfWeek,
    date: input.date !== undefined ? input.date : slot.date,
    startTime: input.startTime ?? slot.startTime,
    endTime: input.endTime ?? slot.endTime,
    slotMinutes: input.slotMinutes ?? slot.slotMinutes,
    mode: input.mode ?? slot.mode,
    location: input.location !== undefined ? input.location : slot.location,
    effectiveFrom: input.effectiveFrom !== undefined ? input.effectiveFrom : slot.effectiveFrom,
    effectiveTo: input.effectiveTo !== undefined ? input.effectiveTo : slot.effectiveTo,
    isActive: input.isActive ?? slot.isActive,
  };
  if (merged.kind === 'recurring') merged.date = null;
  else {
    merged.dayOfWeek = null;
    merged.effectiveFrom = null;
    merged.effectiveTo = null;
  }
  validateSlotShape(merged);
  if (input.branchId && input.branchId !== slot.branchId) {
    await assertBranchExists(input.branchId);
    await slot.update({ ...merged, branchId: input.branchId });
  } else await slot.update(merged);
  await audit({
    action: 'appointments.slot.update',
    entityType: 'AppointmentSlot',
    entityId: id,
    metadata: { before, after: slotDto(slot) },
  });
  return slotDto(slot);
}

export async function deleteSlot(id: number) {
  const slot = await loadSlot(id);
  const before = slotDto(slot);
  await slot.destroy();
  await audit({
    action: 'appointments.slot.delete',
    entityType: 'AppointmentSlot',
    entityId: id,
    metadata: { before },
  });
}

// ---------------------------------------------------------------- availability

async function bookedRanges(
  teacherUserId: number,
  from: string,
  to: string,
  excludeId?: number,
  transaction?: Transaction,
) {
  const { instituteId } = requireTenantContext();
  const rows = await Appointment.findAll({
    where: {
      instituteId,
      teacherUserId,
      date: { [Op.between]: [from, to] },
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
    attributes: ['id', 'date', 'startTime', 'endTime'],
    transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  const map = new Map<string, [number, number][]>();
  for (const r of rows) {
    const list = map.get(r.date) ?? [];
    list.push([toMinutes(r.startTime), toMinutes(r.endTime)]);
    map.set(r.date, list);
  }
  return map;
}

const slotModes = (m: SlotMode): AppointmentMode[] => (m === 'both' ? ['online', 'offline'] : [m]);

/**
 * Expands a teacher's active slots into bookable chunks between `from` and `to` (inclusive),
 * skipping chunks in the past or overlapping requested/confirmed appointments.
 */
export async function computeAvailability(
  teacherUserId: number,
  from: string,
  to: string,
  opts: { branchId?: number; excludeAppointmentId?: number; transaction?: Transaction } = {},
): Promise<AvailableSlotDto[]> {
  if (to < from) throw BadRequest('to must be on or after from');
  if (daysBetween(from, to) > MAX_AVAILABILITY_DAYS)
    throw BadRequest(`The range may span at most ${MAX_AVAILABILITY_DAYS} days`);
  const { instituteId } = requireTenantContext();
  const slots = await AppointmentSlot.findAll({
    where: {
      instituteId,
      teacherUserId,
      isActive: true,
      ...(opts.branchId ? { branchId: opts.branchId } : {}),
    },
    transaction: opts.transaction,
  });
  const booked = await bookedRanges(teacherUserId, from, to, opts.excludeAppointmentId, opts.transaction);
  const now = Date.now();
  const tz = await getInstituteTimezone();
  const out: AvailableSlotDto[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const dow = dayOfWeek(date);
    for (const s of slots) {
      const applies =
        s.kind === 'one_off'
          ? s.date === date
          : s.dayOfWeek === dow &&
            (!s.effectiveFrom || s.effectiveFrom <= date) &&
            (!s.effectiveTo || s.effectiveTo >= date);
      if (!applies) continue;
      const end = toMinutes(s.endTime);
      for (let start = toMinutes(s.startTime); start + s.slotMinutes <= end; start += s.slotMinutes) {
        const chunkEnd = start + s.slotMinutes;
        if (localInstant(date, fromMinutes(start), tz).getTime() <= now) continue;
        if ((booked.get(date) ?? []).some(([a, b]) => overlaps(start, chunkEnd, a, b))) continue;
        out.push({
          slotId: s.id,
          branchId: s.branchId,
          date,
          startTime: fromMinutes(start),
          endTime: fromMinutes(chunkEnd),
          modes: slotModes(s.mode),
          location: s.location,
        });
      }
    }
  }
  // Overlapping slot definitions can yield the same chunk twice; keep the first.
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
    .filter((c) => {
      const k = `${c.date} ${c.startTime}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** Availability as seen by a parent for one of their children (child's branch only). */
export async function availabilityForParent(
  teacherUserId: number,
  studentId: number,
  from: string,
  to: string,
) {
  await assertTeachesChild(studentId, teacherUserId);
  const { student } = await childForParent(studentId);
  return computeAvailability(teacherUserId, from, to, { branchId: student.branchId });
}

/** Availability as seen by the teacher themself or a manager of a branch the teacher works in. */
export async function availabilityForStaff(teacherUserId: number, from: string, to: string) {
  if (teacherUserId !== me()) {
    if (!isManager() || !(await usersWithRole([teacherUserId], 'teacher')).has(teacherUserId))
      throw NotFound('Teacher');
    await assertMemberInBranchScope(teacherUserId, 'read');
  }
  return computeAvailability(teacherUserId, from, to);
}

// ---------------------------------------------------------------- history + notifications

async function recordEvent(
  a: Appointment,
  action: AppointmentEventAction,
  fromStatus: AppointmentStatus | null,
  note: string | null = null,
  metadata: Record<string, unknown> | null = null,
  transaction?: Transaction,
) {
  await AppointmentEvent.create(
    {
      instituteId: a.instituteId,
      appointmentId: a.id,
      actorUserId: getContext().userId ?? null,
      action,
      fromStatus,
      toStatus: a.status,
      note,
      metadata,
    },
    { transaction },
  );
}

async function names(a: Appointment) {
  const users = await User.findAll({
    where: { id: { [Op.in]: [a.teacherUserId, a.requestedByUserId] } },
    attributes: ['id', 'name'],
  });
  const name = (id: number) => users.find((u) => u.id === id)?.name ?? '';
  return { teacher: name(a.teacherUserId), requester: name(a.requestedByUserId) };
}

const vars = async (a: Appointment) => ({
  ...(await names(a)),
  date: a.date,
  time: a.startTime,
  mode: a.mode,
  appointmentId: a.id,
  meetingUrl: a.meetingUrl ?? '',
  location: a.location ?? '',
});

const toParents = (a: Appointment) => [
  guardiansOf(a.studentId),
  { userIds: [a.requestedByUserId], type: 'guardian' as const },
];
const toTeacher = (a: Appointment) => ({ userIds: [a.teacherUserId], type: 'staff' as const });

async function send(
  event: string,
  a: Appointment,
  recipients: Parameters<typeof notify>[0]['recipients'],
  extra: Record<string, unknown> = {},
) {
  await notify({ event, recipients, data: { ...(await vars(a)), ...extra }, branchId: a.branchId });
}

// ---------------------------------------------------------------- calendar + reminders

function calendarInput(
  a: Appointment,
  teacher: string,
  requester: string,
  studentName: string,
): CalendarEventInput {
  return {
    externalRef: `appointments:${a.id}`,
    title: `Parent-teacher meeting: ${studentName}`,
    description: a.agenda ?? undefined,
    start: `${a.date}T${a.startTime}`,
    end: `${a.date}T${a.endTime}`,
    attendees: [{ name: teacher }, { name: requester }],
    withMeeting: a.mode === 'online',
    location: a.mode === 'offline' ? a.location : null,
  };
}

/** Creates or updates the calendar event (with a meeting link for online meetings). */
async function syncCalendar(a: Appointment, meetingUrlOverride?: string | null) {
  const provider = getCalendarProvider(a.instituteId, a.calendarProvider ?? 'mock');
  const n = await names(a);
  const student = await Student.findOne({
    where: { instituteId: a.instituteId, id: a.studentId },
    attributes: ['name'],
  });
  const input = calendarInput(a, n.teacher, n.requester, student?.name ?? '');
  const res = a.calendarEventId
    ? await provider.updateEvent(a.calendarEventId, input)
    : await provider.createEvent(input);
  a.calendarProvider = provider.name;
  a.calendarEventId = res.eventId;
  a.meetingUrl = a.mode === 'online' ? (meetingUrlOverride ?? res.meetingUrl) : null;
}

async function cancelCalendar(a: Appointment) {
  if (!a.calendarEventId) return;
  await getCalendarProvider(a.instituteId, a.calendarProvider ?? 'mock').cancelEvent(a.calendarEventId);
}

const reminderBase = (a: Appointment) => `${a.date}T${a.startTime}`;

/** Queues reminder jobs; stale ones (after a reschedule/cancel) are ignored by the handler. */
async function scheduleReminders(a: Appointment) {
  const start = localInstant(a.date, a.startTime, await getInstituteTimezone(a.instituteId)).getTime();
  for (const lead of REMINDER_LEADS_MINUTES) {
    const runAt = new Date(start - lead * 60_000);
    if (runAt.getTime() <= Date.now()) continue;
    await enqueueJob(REMINDER_JOB, { appointmentId: a.id, startsAt: reminderBase(a), lead }, { runAt });
  }
}

/** `appointments.reminder` job: runs in the institute's context; idempotent. */
export async function runReminder(payload: { appointmentId: number; startsAt: string; lead: number }) {
  const { instituteId } = requireTenantContext();
  const a = await Appointment.findOne({ where: { instituteId, id: payload.appointmentId } });
  if (!a || a.status !== 'confirmed' || reminderBase(a) !== payload.startsAt) return;
  const key = `${payload.startsAt}|${payload.lead}`;
  if (a.lastReminderKey === key) return;
  await send('appointments.reminder', a, [...toParents(a), toTeacher(a)]);
  await a.update({ lastReminderKey: key });
  await recordEvent(a, 'reminder_sent', a.status, null, { lead: payload.lead });
}

// ---------------------------------------------------------------- loading with row-level access

async function loadAppointment(id: number, transaction?: Transaction) {
  const { instituteId } = requireTenantContext();
  const a = await Appointment.findOne({ where: { instituteId, id }, include: apptIncludes, transaction });
  if (!a) throw NotFound('Appointment');
  return a;
}

type ActorRole = 'teacher' | 'parent' | 'manager';

/** Who the current user is relative to the appointment; 404 when they may not see it. */
async function roleFor(a: Appointment): Promise<ActorRole> {
  const uid = me();
  if (a.teacherUserId === uid) return 'teacher';
  if (a.requestedByUserId === uid || (await linkedStudentIds()).includes(a.studentId)) return 'parent';
  if (canSeeAll()) {
    const { allowedBranchIds } = requireTenantContext();
    if (allowedBranchIds === null || allowedBranchIds.includes(a.branchId)) return 'manager';
  }
  throw NotFound('Appointment');
}

async function loadAs(id: number, allowed: ActorRole[], transaction?: Transaction) {
  const a = await loadAppointment(id, transaction);
  const role = await roleFor(a);
  // Report viewers (`export` without `configure`) may read but not act on other teachers' meetings.
  if (!allowed.includes(role) || (role === 'manager' && !isManager()))
    throw Forbidden('You cannot perform this action on the appointment');
  return { a, role };
}

function assertStatus(a: Appointment, allowed: AppointmentStatus[]) {
  if (!allowed.includes(a.status))
    throw Conflict(`The appointment is ${a.status}`, 'INVALID_STATUS', { status: a.status });
}

// ---------------------------------------------------------------- queries

export interface ListQuery {
  page: number;
  pageSize: number;
  status?: AppointmentStatus[];
  from?: string;
  to?: string;
  studentId?: number;
  teacherUserId?: number;
  branchId?: number;
  upcoming?: boolean;
}

async function filters(q: ListQuery) {
  const where: Record<string | symbol, unknown> = {};
  if (q.status?.length) where.status = { [Op.in]: q.status };
  if (q.from || q.to)
    where.date = { ...(q.from ? { [Op.gte]: q.from } : {}), ...(q.to ? { [Op.lte]: q.to } : {}) };
  if (q.upcoming) where.date = { ...(where.date as object), [Op.gte]: await localToday() };
  if (q.studentId) where.studentId = q.studentId;
  if (q.teacherUserId) where.teacherUserId = q.teacherUserId;
  return where;
}

/** The current user's appointments: as the teacher, as the requester or as a guardian of the child. */
export async function listMine(q: ListQuery) {
  const { instituteId } = requireTenantContext();
  const uid = me();
  const children = await linkedStudentIds();
  const or: WhereOptions[] = [{ teacherUserId: uid }, { requestedByUserId: uid }];
  if (children.length) or.push({ studentId: { [Op.in]: children } });
  const { rows, count } = await Appointment.findAndCountAll({
    where: { ...(await filters(q)), instituteId, [Op.or]: or } as WhereOptions<Appointment>,
    include: apptIncludes,
    order: q.upcoming
      ? [
          ['date', 'ASC'],
          ['startTime', 'ASC'],
        ]
      : [
          ['date', 'DESC'],
          ['startTime', 'DESC'],
        ],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
    distinct: true,
  });
  return { items: rows.map(appointmentDto), total: count, page: q.page, pageSize: q.pageSize };
}

/** Branch-wide list for managers/report viewers. */
export async function listAll(q: ListQuery) {
  if (!canSeeAll()) return listMine(q);
  const where = await filters(q);
  if (q.branchId) {
    apptRepo.assertBranchAllowed(q.branchId);
    where.branchId = q.branchId;
  }
  const { rows, count } = await apptRepo.findAndCountAll({
    where,
    include: apptIncludes,
    order: [
      ['date', 'DESC'],
      ['startTime', 'DESC'],
    ],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  return { items: rows.map(appointmentDto), total: count, page: q.page, pageSize: q.pageSize };
}

export async function getDetail(id: number): Promise<AppointmentDetailDto> {
  const a = await loadAppointment(id);
  await roleFor(a);
  const events = await AppointmentEvent.findAll({
    where: { instituteId: a.instituteId, appointmentId: a.id },
    include: [{ model: User, as: 'actor', ...userRef }],
    order: [['id', 'ASC']],
  });
  return { ...appointmentDto(a), history: events.map(eventDto) };
}

// ---------------------------------------------------------------- lifecycle

export interface RequestInput {
  studentId: number;
  teacherUserId: number;
  date: string;
  startTime: string;
  mode: AppointmentMode;
  agenda?: string | null;
}

/** Finds the bookable chunk starting at date/time in the child's branch; throws when unavailable. */
async function findChunk(
  teacherUserId: number,
  branchId: number,
  date: string,
  startTime: string,
  mode: AppointmentMode,
  opts: { excludeAppointmentId?: number; transaction?: Transaction } = {},
) {
  const chunks = await computeAvailability(teacherUserId, date, date, { branchId, ...opts });
  const chunk = chunks.find((c) => c.startTime === startTime);
  if (!chunk) throw Conflict('This time is not available', 'SLOT_UNAVAILABLE');
  if (!chunk.modes.includes(mode))
    throw BadRequest(`The teacher does not offer ${mode} meetings at this time`);
  return chunk;
}

export async function requestAppointment(input: RequestInput) {
  const uid = me();
  await assertTeachesChild(input.studentId, input.teacherUserId);
  const { student } = await childForParent(input.studentId);
  const { instituteId } = requireTenantContext();
  const pending = await Appointment.count({
    where: {
      instituteId,
      studentId: input.studentId,
      teacherUserId: input.teacherUserId,
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
    },
  });
  if (pending)
    throw Conflict(
      'There is already an open meeting request with this teacher for this child',
      'ALREADY_REQUESTED',
    );

  const appt = await getSequelize().transaction(async (transaction) => {
    const chunk = await findChunk(
      input.teacherUserId,
      student.branchId,
      input.date,
      input.startTime,
      input.mode,
      { transaction },
    );
    const a = await Appointment.create(
      {
        instituteId,
        branchId: chunk.branchId,
        slotId: chunk.slotId,
        teacherUserId: input.teacherUserId,
        requestedByUserId: uid,
        studentId: student.id,
        studentUserId: student.userId,
        date: chunk.date,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        mode: input.mode,
        agenda: input.agenda ?? null,
        location: input.mode === 'offline' ? chunk.location : null,
      },
      { transaction },
    );
    await recordEvent(a, 'requested', null, input.agenda ?? null, null, transaction);
    return a;
  });
  await audit({
    action: 'appointments.request',
    entityType: 'Appointment',
    entityId: appt.id,
    metadata: {
      studentId: input.studentId,
      teacherUserId: input.teacherUserId,
      date: appt.date,
      startTime: appt.startTime,
    },
  });
  await send('appointments.requested', appt, [toTeacher(appt)], { student: student.name });
  return appointmentDto(await loadAppointment(appt.id));
}

export async function approve(
  id: number,
  input: { note?: string | null; location?: string | null; meetingUrl?: string | null },
) {
  const { a } = await loadAs(id, ['teacher', 'manager']);
  assertStatus(a, ['requested']);
  const from = a.status;
  if (input.location !== undefined && a.mode === 'offline') a.location = input.location;
  await syncCalendar(a, input.meetingUrl);
  await a.update({
    status: 'confirmed',
    responseNote: input.note ?? null,
    respondedAt: a.respondedAt ?? new Date(),
    location: a.location,
    meetingUrl: a.meetingUrl,
    calendarEventId: a.calendarEventId,
    calendarProvider: a.calendarProvider,
  });
  await recordEvent(
    a,
    'approved',
    from,
    input.note ?? null,
    a.meetingUrl ? { meetingUrl: a.meetingUrl } : null,
  );
  await audit({
    action: 'appointments.approve',
    entityType: 'Appointment',
    entityId: id,
    metadata: { from, to: 'confirmed' },
  });
  await scheduleReminders(a);
  await send('appointments.confirmed', a, toParents(a));
  return appointmentDto(a);
}

export async function reject(id: number, reason: string) {
  const { a } = await loadAs(id, ['teacher', 'manager']);
  assertStatus(a, ['requested']);
  const from = a.status;
  await a.update({ status: 'rejected', responseNote: reason, respondedAt: a.respondedAt ?? new Date() });
  await recordEvent(a, 'rejected', from, reason);
  await audit({
    action: 'appointments.reject',
    entityType: 'Appointment',
    entityId: id,
    metadata: { from, reason },
  });
  await send('appointments.rejected', a, toParents(a), { reason });
  return appointmentDto(a);
}

export interface RescheduleInput {
  date: string;
  startTime: string;
  /** Teachers may set any length; parents get the slot length. */
  endTime?: string;
  mode?: AppointmentMode;
  reason?: string | null;
}

/**
 * Teacher/manager reschedule: any free time (confirmed immediately). Parent reschedule: another
 * available slot chunk; goes back to `requested` for the teacher to approve.
 */
export async function reschedule(id: number, input: RescheduleInput) {
  const { a, role } = await loadAs(id, ['teacher', 'manager', 'parent']);
  assertStatus(a, ['requested', 'confirmed']);
  const from = a.status;
  const before = { date: a.date, startTime: a.startTime, endTime: a.endTime, mode: a.mode };
  const mode = input.mode ?? a.mode;
  await getSequelize().transaction(async (transaction) => {
    if (role === 'parent') {
      const chunk = await findChunk(a.teacherUserId, a.branchId, input.date, input.startTime, mode, {
        excludeAppointmentId: a.id,
        transaction,
      });
      a.set({
        date: chunk.date,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        slotId: chunk.slotId,
        status: 'requested',
      });
      if (mode === 'offline') a.location = chunk.location;
    } else {
      const len = toMinutes(a.endTime) - toMinutes(a.startTime);
      const endTime = input.endTime ?? fromMinutes(toMinutes(input.startTime) + len);
      if (toMinutes(endTime) <= toMinutes(input.startTime) || toMinutes(endTime) > 24 * 60)
        throw BadRequest('endTime must be after startTime on the same day');
      if (localInstant(input.date, input.startTime, await getInstituteTimezone()).getTime() <= Date.now())
        throw BadRequest('The new time is in the past');
      const booked = await bookedRanges(a.teacherUserId, input.date, input.date, a.id, transaction);
      if (
        (booked.get(input.date) ?? []).some(([s, e]) =>
          overlaps(toMinutes(input.startTime), toMinutes(endTime), s, e),
        )
      )
        throw Conflict('The teacher already has a meeting at this time', 'SLOT_UNAVAILABLE');
      a.set({ date: input.date, startTime: input.startTime, endTime, status: 'confirmed' });
      a.respondedAt = a.respondedAt ?? new Date();
    }
    a.mode = mode;
    if (mode === 'online') a.location = null;
    a.rescheduleCount = a.rescheduleCount + 1;
    await a.save({ transaction });
  });
  if (a.status === 'confirmed') {
    await syncCalendar(a);
    await a.save();
    await scheduleReminders(a);
  } else if (a.calendarEventId) {
    await cancelCalendar(a);
    await a.update({ calendarEventId: null, meetingUrl: null });
  }
  const after = { date: a.date, startTime: a.startTime, endTime: a.endTime, mode: a.mode };
  await recordEvent(a, 'rescheduled', from, input.reason ?? null, { before, after });
  await audit({
    action: 'appointments.reschedule',
    entityType: 'Appointment',
    entityId: id,
    metadata: { before, after, by: role },
  });
  await send('appointments.rescheduled', a, role === 'parent' ? [toTeacher(a)] : toParents(a), {
    reason: input.reason ?? '',
    previousDate: before.date,
    previousTime: before.startTime,
  });
  return appointmentDto(a);
}

export async function cancel(id: number, reason: string) {
  const { a, role } = await loadAs(id, ['teacher', 'manager', 'parent']);
  assertStatus(a, ['requested', 'confirmed']);
  const from = a.status;
  await cancelCalendar(a);
  await a.update({ status: 'cancelled', cancelReason: reason, cancelledByUserId: me() });
  await recordEvent(a, 'cancelled', from, reason);
  await audit({
    action: 'appointments.cancel',
    entityType: 'Appointment',
    entityId: id,
    metadata: { from, reason, by: role },
  });
  await send(
    'appointments.cancelled',
    a,
    role === 'parent' ? [{ userIds: [a.teacherUserId] }] : toParents(a),
    { reason },
  );
  return appointmentDto(a);
}

export async function complete(
  id: number,
  input: { outcome: 'completed' | 'no_show'; sharedSummary?: string | null; privateNotes?: string | null },
) {
  const { a } = await loadAs(id, ['teacher', 'manager']);
  assertStatus(a, ['confirmed']);
  if (a.date > (await localToday())) throw BadRequest('The meeting has not happened yet');
  const from = a.status;
  await a.update({
    status: input.outcome,
    completedAt: new Date(),
    ...(input.sharedSummary !== undefined ? { sharedSummary: input.sharedSummary } : {}),
    ...(input.privateNotes !== undefined ? { privateNotes: input.privateNotes } : {}),
  });
  await recordEvent(a, input.outcome === 'completed' ? 'completed' : 'no_show', from);
  await audit({
    action: 'appointments.complete',
    entityType: 'Appointment',
    entityId: id,
    metadata: { from, to: input.outcome },
  });
  if (input.outcome === 'completed' && a.sharedSummary)
    await send('appointments.summary-shared', a, toParents(a), { summary: a.sharedSummary });
  return appointmentDto(a);
}

export async function updateNotes(
  id: number,
  input: { sharedSummary?: string | null; privateNotes?: string | null },
) {
  const { a } = await loadAs(id, ['teacher', 'manager']);
  assertStatus(a, ['confirmed', 'completed', 'no_show']);
  const hadSummary = a.sharedSummary;
  await a.update({
    ...(input.sharedSummary !== undefined ? { sharedSummary: input.sharedSummary } : {}),
    ...(input.privateNotes !== undefined ? { privateNotes: input.privateNotes } : {}),
  });
  await recordEvent(a, 'notes_updated', a.status, null, {
    sharedSummary: input.sharedSummary !== undefined,
    privateNotes: input.privateNotes !== undefined,
  });
  await audit({
    action: 'appointments.notes',
    entityType: 'Appointment',
    entityId: id,
    metadata: { fields: Object.keys(input) },
  });
  if (a.status === 'completed' && a.sharedSummary && a.sharedSummary !== hadSummary)
    await send('appointments.summary-shared', a, toParents(a), { summary: a.sharedSummary });
  return appointmentDto(a);
}

// ---------------------------------------------------------------- reports

export interface ReportQuery {
  from?: string;
  to?: string;
  branchId?: number;
  teacherUserId?: number;
}

async function reportRows(q: ReportQuery) {
  const where = await filters({
    page: 1,
    pageSize: 1,
    from: q.from,
    to: q.to,
    teacherUserId: q.teacherUserId,
  });
  if (q.branchId) {
    apptRepo.assertBranchAllowed(q.branchId);
    where.branchId = q.branchId;
  }
  return apptRepo.findAll({
    where,
    include: apptIncludes,
    order: [
      ['date', 'ASC'],
      ['startTime', 'ASC'],
    ],
    limit: 20_000,
  });
}

export async function reportSummary(q: ReportQuery): Promise<AppointmentReportSummary> {
  const rows = await reportRows(q);
  const byStatus = Object.fromEntries(
    (['requested', 'confirmed', 'rejected', 'cancelled', 'completed', 'no_show'] as const).map((s) => [s, 0]),
  ) as AppointmentReportSummary['byStatus'];
  const byMode = { online: 0, offline: 0 };
  const branches = new Map<number, { total: number; completed: number }>();
  const teachers = new Map<number, AppointmentReportSummary['byTeacher'][number]>();
  let responseMs = 0;
  let responded = 0;
  for (const r of rows) {
    byStatus[r.status as AppointmentStatus]++;
    byMode[r.mode]++;
    const b = branches.get(r.branchId) ?? { total: 0, completed: 0 };
    b.total++;
    if (r.status === 'completed') b.completed++;
    branches.set(r.branchId, b);
    const t = teachers.get(r.teacherUserId) ?? {
      teacherUserId: r.teacherUserId,
      teacherName: r.teacher?.name ?? null,
      total: 0,
      confirmed: 0,
      completed: 0,
      rejected: 0,
      cancelled: 0,
    };
    t.total++;
    if (r.status === 'confirmed') t.confirmed++;
    if (r.status === 'completed') t.completed++;
    if (r.status === 'rejected') t.rejected++;
    if (r.status === 'cancelled') t.cancelled++;
    teachers.set(r.teacherUserId, t);
    if (r.respondedAt) {
      responseMs += r.respondedAt.getTime() - r.createdAt.getTime();
      responded++;
    }
  }
  const { instituteId } = requireTenantContext();
  const branchRows = branches.size
    ? await Branch.findAll({
        where: { instituteId, id: { [Op.in]: [...branches.keys()] } },
        attributes: ['id', 'name'],
      })
    : [];
  return {
    total: rows.length,
    byStatus,
    byMode,
    byBranch: [...branches.entries()].map(([branchId, v]) => ({
      branchId,
      branchName: branchRows.find((b) => b.id === branchId)?.name ?? null,
      ...v,
    })),
    byTeacher: [...teachers.values()].sort((a, b) => b.total - a.total),
    avgResponseHours: responded ? Math.round((responseMs / responded / 3_600_000) * 10) / 10 : null,
  };
}

/** Escapes a CSV cell and neutralises spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(q: ReportQuery): Promise<string> {
  const rows = await reportRows(q);
  const header = [
    'Id',
    'Branch',
    'Date',
    'Start',
    'End',
    'Mode',
    'Status',
    'Teacher',
    'Parent',
    'Student',
    'Agenda',
    'Rescheduled',
    'Requested at',
    'Responded at',
    'Completed at',
    'Summary',
  ];
  const { instituteId } = requireTenantContext();
  const branchRows = await Branch.findAll({ where: { instituteId }, attributes: ['id', 'name'] });
  const branchName = new Map(branchRows.map((b) => [b.id, b.name]));
  const lines = rows.map((r) =>
    [
      r.id,
      branchName.get(r.branchId) ?? r.branchId,
      r.date,
      r.startTime,
      r.endTime,
      r.mode,
      r.status,
      r.teacher?.name,
      r.requestedBy?.name,
      r.student?.name,
      r.agenda,
      r.rescheduleCount,
      r.createdAt.toISOString(),
      r.respondedAt?.toISOString(),
      r.completedAt?.toISOString(),
      r.sharedSummary,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

// ---------------------------------------------------------------- parent-portal provider

/** Appointments of a child, for the parent dashboard / monthly report section. */
export async function childAppointmentStats(studentId: number, from: string, to: string) {
  const { instituteId } = requireTenantContext();
  const rows = await Appointment.findAll({
    where: { instituteId, studentId, date: { [Op.between]: [from, to] } },
    include: [{ model: User, as: 'teacher', ...userRef }],
    order: [
      ['date', 'ASC'],
      ['startTime', 'ASC'],
    ],
  });
  return rows;
}
