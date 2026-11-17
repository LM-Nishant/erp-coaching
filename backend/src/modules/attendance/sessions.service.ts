import { Op, UniqueConstraintError, col, fn, type Transaction } from 'sequelize';
import type {
  AttendanceRecordSource,
  AttendanceSessionDto,
  AttendanceSettingsDto,
  AttendanceStatus,
  CheckInResult,
  QrTokenDto,
  RosterEntryDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { hmac, randomToken, safeEqual } from '../../infrastructure/crypto';
import { getContext, hasPermission, requireTenantContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { User } from '../users/user.model';
import { Batch, BatchStudent, BatchTeacher, ClassSession, Subject } from '../academics/api';
import { guardiansOfStudentUsers, notify } from '../notifications/api';
import { AttendanceRecord, AttendanceSession, StudentLeaveRequest } from './models';
import { getAttendanceSettings } from './settings';
import { distanceMetres, localDate, minutesSinceStart } from './time';

export const ABSENT_ALERTS_JOB = 'attendance.absent-alerts';

/** Staff access: branch-scoped. */
export const sessionRepo = new TenantRepository(AttendanceSession, {
  entity: 'Attendance session',
  branchScoped: true,
});
export const recordRepo = new TenantRepository(AttendanceRecord, {
  entity: 'Attendance record',
  branchScoped: true,
});
/** Self-service and system access: institute-scoped; ownership is checked via batch enrolment. */
const sessionAnyRepo = new TenantRepository(AttendanceSession, { entity: 'Attendance session' });
const classScoped = new TenantRepository(ClassSession, { entity: 'Class session', branchScoped: true });
const classAny = new TenantRepository(ClassSession, { entity: 'Class session' });
const batchScoped = new TenantRepository(Batch, { entity: 'Batch', branchScoped: true });
const batchAny = new TenantRepository(Batch, { entity: 'Batch' });
const enrolmentRepo = new TenantRepository(BatchStudent, { entity: 'Enrollment' });
const batchTeacherRepo = new TenantRepository(BatchTeacher, { entity: 'Batch teacher' });
const leaveRepo = new TenantRepository(StudentLeaveRequest, { entity: 'Leave request' });

/* ------------------------------------------------------------------ sessions */

export function toSessionDto(
  s: AttendanceSession,
  extra: Partial<AttendanceSessionDto> = {},
): AttendanceSessionDto {
  return {
    id: s.id,
    branchId: s.branchId,
    batchId: s.batchId,
    batchName: s.batch?.name,
    classSessionId: s.classSessionId,
    kind: s.kind,
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    teacherUserId: s.teacherUserId,
    status: s.status,
    closedAt: s.closedAt ? s.closedAt.toISOString() : null,
    ...extra,
  };
}

async function getOrCreateSession(
  key: string,
  values: Pick<
    AttendanceSession,
    'branchId' | 'batchId' | 'classSessionId' | 'kind' | 'date' | 'startTime' | 'endTime' | 'teacherUserId'
  >,
): Promise<AttendanceSession> {
  const { instituteId } = requireTenantContext();
  const find = () => AttendanceSession.findOne({ where: { instituteId, sessionKey: key } });
  const existing = await find();
  if (existing) {
    // Keep class details in sync after a reschedule/substitution while attendance is still open.
    if (existing.kind === 'class' && existing.status === 'open') {
      const diff = (['date', 'startTime', 'endTime', 'teacherUserId'] as const).some(
        (k) => existing[k] !== values[k],
      );
      if (diff)
        await existing.update({
          date: values.date,
          startTime: values.startTime,
          endTime: values.endTime,
          teacherUserId: values.teacherUserId,
        });
    }
    return existing;
  }
  try {
    return await AttendanceSession.create({
      ...values,
      instituteId,
      sessionKey: key,
      qrSecret: randomToken(24),
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) return (await find())!;
    throw err;
  }
}

export interface SessionRef {
  classSessionId?: number;
  batchId?: number;
  date?: string;
}

/**
 * Finds or creates the attendance session for a class (class mode) or a batch-day (daily mode).
 * In daily mode a class reference maps to its batch-day. `scoped` applies the caller's branch scope.
 */
export async function resolveSession(
  ref: SessionRef,
  opts: { scoped?: boolean; settings?: AttendanceSettingsDto } = {},
): Promise<AttendanceSession> {
  const settings = opts.settings ?? (await getAttendanceSettings());
  const classes = opts.scoped ? classScoped : classAny;
  const batches = opts.scoped ? batchScoped : batchAny;
  if (ref.classSessionId) {
    const cs = await classes.findById(ref.classSessionId);
    if (cs.status === 'cancelled') throw BadRequest('This class was cancelled');
    if (settings.mode === 'daily') return dailySession(await batches.findById(cs.batchId), cs.date);
    return getOrCreateSession(`class:${cs.id}`, {
      branchId: cs.branchId,
      batchId: cs.batchId,
      classSessionId: cs.id,
      kind: 'class',
      date: cs.date,
      startTime: cs.startTime,
      endTime: cs.endTime,
      teacherUserId: cs.teacherUserId,
    });
  }
  if (!ref.batchId) throw BadRequest('classSessionId or batchId is required');
  if (settings.mode === 'class')
    throw new AppError(400, 'MODE_CLASS', 'Attendance is taken per class session; pass classSessionId');
  return dailySession(await batches.findById(ref.batchId), ref.date ?? localDate());
}

function dailySession(batch: Batch, date: string) {
  return getOrCreateSession(`daily:${batch.id}:${date}`, {
    branchId: batch.branchId,
    batchId: batch.id,
    classSessionId: null,
    kind: 'daily',
    date,
    startTime: null,
    endTime: null,
    teacherUserId: null,
  });
}

export async function getSessionScoped(id: number) {
  return sessionRepo.findById(id, { include: [{ model: Batch, as: 'batch', attributes: ['id', 'name'] }] });
}

/** Staff with `attendance.edit`, or a teacher (with `attendance.create`) of the class or batch. */
export async function canManageSession(session: AttendanceSession): Promise<boolean> {
  if (hasPermission('attendance.edit')) return true;
  if (!hasPermission('attendance.create')) return false;
  const { userId } = getContext();
  if (!userId) return false;
  if (session.teacherUserId === userId) return true;
  if (session.classSessionId) {
    const cs = await classAny.findOne({ where: { id: session.classSessionId } });
    if (cs && (cs.teacherUserId === userId || cs.originalTeacherUserId === userId)) return true;
  }
  return (await batchTeacherRepo.count({ batchId: session.batchId, teacherUserId: userId })) > 0;
}

export async function assertCanManageSession(session: AttendanceSession) {
  if (!(await canManageSession(session)))
    throw Forbidden('Only the class or batch teacher can take this attendance', 'NOT_CLASS_TEACHER');
}

export function assertMethodEnabled(settings: AttendanceSettingsDto, method: string) {
  if (!(settings.methods as string[]).includes(method))
    throw Forbidden(`The ${method} attendance method is not enabled`, 'METHOD_DISABLED');
}

/* -------------------------------------------------------------------- roster */

/** Student user ids enrolled in the batch on `date`. */
export async function rosterStudentIds(batchId: number, date: string, t?: Transaction): Promise<number[]> {
  const rows = await enrolmentRepo.findAll({
    where: {
      batchId,
      joinedOn: { [Op.lte]: date },
      [Op.or]: [{ leftOn: null }, { leftOn: { [Op.gte]: date } }],
    },
    attributes: ['studentUserId'],
    transaction: t,
  });
  return [...new Set(rows.map((r) => r.studentUserId))];
}

/** Students among `ids` with approved leave covering `date`. */
export async function studentsOnLeave(ids: number[], date: string, t?: Transaction): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await leaveRepo.findAll({
    where: {
      studentUserId: { [Op.in]: ids },
      status: 'approved',
      fromDate: { [Op.lte]: date },
      toDate: { [Op.gte]: date },
    },
    attributes: ['studentUserId'],
    transaction: t,
  });
  return new Set(rows.map((r) => r.studentUserId));
}

export async function getRoster(session: AttendanceSession): Promise<RosterEntryDto[]> {
  const { instituteId } = requireTenantContext();
  const records = await AttendanceRecord.findAll({
    where: { instituteId, attendanceSessionId: session.id },
  });
  const byStudent = new Map(records.map((r) => [r.studentUserId, r]));
  const ids = [...new Set([...(await rosterStudentIds(session.batchId, session.date)), ...byStudent.keys()])];
  const [users, leave] = await Promise.all([
    ids.length ? User.findAll({ where: { id: ids }, attributes: ['id', 'name'] }) : [],
    studentsOnLeave(ids, session.date),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  return ids
    .map((id) => {
      const r = byStudent.get(id);
      return {
        studentUserId: id,
        name: names.get(id) ?? `#${id}`,
        status: r?.status ?? null,
        source: r?.source ?? null,
        markedAt: r ? r.markedAt.toISOString() : null,
        remarks: r?.remarks ?? null,
        onLeave: leave.has(id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Status counts per attendance session. */
export async function countsFor(sessionIds: number[]) {
  const out = new Map<number, Partial<Record<AttendanceStatus, number>>>();
  if (!sessionIds.length) return out;
  const { instituteId } = requireTenantContext();
  const rows = (await AttendanceRecord.findAll({
    where: { instituteId, attendanceSessionId: { [Op.in]: sessionIds } },
    attributes: ['attendanceSessionId', 'status', [fn('COUNT', col('id')), 'n']],
    group: ['attendanceSessionId', 'status'],
    raw: true,
  })) as unknown as { attendanceSessionId: number; status: AttendanceStatus; n: number }[];
  for (const r of rows) {
    const c = out.get(r.attendanceSessionId) ?? {};
    c[r.status] = Number(r.n);
    out.set(r.attendanceSessionId, c);
  }
  return out;
}

/* ------------------------------------------------------------------- marking */

interface ApplyOptions {
  /** Manual marks and approved corrections overwrite; automatic methods never replace an existing mark. */
  overwrite: boolean;
  markedByUserId?: number | null;
  markedAt?: Date;
  remarks?: string | null;
  lat?: number | null;
  lng?: number | null;
  transaction?: Transaction;
}

export async function applyRecord(
  session: AttendanceSession,
  studentUserId: number,
  status: AttendanceStatus,
  source: AttendanceRecordSource,
  o: ApplyOptions,
): Promise<{ record: AttendanceRecord; duplicate: boolean }> {
  const { instituteId } = requireTenantContext();
  const where = { instituteId, attendanceSessionId: session.id, studentUserId };
  const existing = await AttendanceRecord.findOne({ where, transaction: o.transaction });
  const values = {
    status,
    source,
    markedAt: o.markedAt ?? new Date(),
    markedByUserId: o.markedByUserId ?? null,
    remarks: o.remarks ?? null,
    lat: o.lat ?? null,
    lng: o.lng ?? null,
  };
  if (existing) {
    if (!o.overwrite) return { record: existing, duplicate: true };
    if (existing.status !== status || (o.remarks !== undefined && existing.remarks !== o.remarks))
      await existing.update(values, { transaction: o.transaction });
    return { record: existing, duplicate: false };
  }
  try {
    const record = await AttendanceRecord.create(
      {
        ...values,
        instituteId,
        branchId: session.branchId,
        attendanceSessionId: session.id,
        batchId: session.batchId,
        date: session.date,
        studentUserId,
      },
      { transaction: o.transaction },
    );
    return { record, duplicate: false };
  } catch (err) {
    // A concurrent check-in (double tap, QR + biometric) won the race.
    if (err instanceof UniqueConstraintError && !o.transaction)
      return { record: (await AttendanceRecord.findOne({ where }))!, duplicate: true };
    throw err;
  }
}

/** Teacher roster marking (bulk upsert). Closed sessions need `attendance.edit`. */
export async function markRoster(
  session: AttendanceSession,
  entries: { studentUserId: number; status: AttendanceStatus; remarks?: string | null }[],
) {
  await assertCanManageSession(session);
  assertMethodEnabled(await getAttendanceSettings(), 'manual');
  if (session.status === 'closed' && !hasPermission('attendance.edit'))
    throw Conflict('Attendance is closed; raise a correction instead', 'SESSION_CLOSED');
  const { instituteId, userId } = requireTenantContext();
  const allowed = new Set(await rosterStudentIds(session.batchId, session.date));
  const existing = await AttendanceRecord.findAll({
    where: { instituteId, attendanceSessionId: session.id },
    attributes: ['studentUserId'],
  });
  existing.forEach((r) => allowed.add(r.studentUserId));
  const bad = entries.filter((e) => !allowed.has(e.studentUserId)).map((e) => e.studentUserId);
  if (bad.length) throw BadRequest('Students are not on this roster', { studentUserIds: bad });
  await getSequelize().transaction(async (transaction) => {
    for (const e of entries)
      await applyRecord(session, e.studentUserId, e.status, 'manual', {
        overwrite: true,
        markedByUserId: userId,
        remarks: e.remarks ?? null,
        transaction,
      });
  });
  return entries.length;
}

/**
 * Closes the session: unmarked students become absent (or leave when an approved leave covers the
 * day) and parent absent alerts are queued. Idempotent.
 */
export async function closeSession(session: AttendanceSession, byUserId: number | null = null) {
  if (session.status === 'closed') return session;
  const { instituteId } = requireTenantContext();
  await getSequelize().transaction(async (transaction) => {
    const ids = await rosterStudentIds(session.batchId, session.date, transaction);
    const marked = new Set(
      (
        await AttendanceRecord.findAll({
          where: { instituteId, attendanceSessionId: session.id },
          attributes: ['studentUserId'],
          transaction,
        })
      ).map((r) => r.studentUserId),
    );
    const unmarked = ids.filter((id) => !marked.has(id));
    const leave = await studentsOnLeave(unmarked, session.date, transaction);
    for (const id of unmarked)
      await applyRecord(session, id, leave.has(id) ? 'leave' : 'absent', leave.has(id) ? 'leave' : 'system', {
        overwrite: false,
        markedByUserId: byUserId,
        transaction,
      });
    await session.update(
      { status: 'closed', closedAt: new Date(), closedByUserId: byUserId },
      { transaction },
    );
  });
  await enqueueJob(ABSENT_ALERTS_JOB, { attendanceSessionId: session.id });
  return session;
}

/** Job: notifies guardians of absent students once per session (`attendance.absent`). */
export async function sendAbsentAlerts(payload: Record<string, unknown>) {
  const { instituteId } = requireTenantContext();
  const id = Number(payload.attendanceSessionId);
  const settings = await getAttendanceSettings();
  if (!settings.absentAlerts) return;
  // Claim first so retries and re-closes never alert twice.
  const [claimed] = await AttendanceSession.update(
    { alertsSentAt: new Date() },
    { where: { instituteId, id, alertsSentAt: null } },
  );
  if (!claimed) return;
  const session = await sessionAnyRepo.findById(id, {
    include: [{ model: Batch, as: 'batch', attributes: ['name'] }],
  });
  const absent = await AttendanceRecord.findAll({
    where: { instituteId, attendanceSessionId: id, status: 'absent' },
    include: [{ model: User, as: 'student', attributes: ['id', 'name'] }],
  });
  for (const r of absent)
    await notify({
      event: 'attendance.absent',
      recipients: [guardiansOfStudentUsers([r.studentUserId])],
      data: { student: { name: r.student?.name ?? '' }, date: session.date, batch: session.batch?.name ?? '' },
      branchId: session.branchId,
    });
}

/* --------------------------------------------------------------- self check-in */

const qrWindow = (rotate: number, now = Date.now()) => Math.floor(now / 1000 / rotate);
const qrSig = (instituteId: number, session: AttendanceSession, w: number) =>
  hmac(`${instituteId}:${session.id}:${w}`, session.qrSecret).slice(0, 22);

/** Rotating QR token for the teacher's screen; valid for the current and previous window. */
export async function issueQrToken(session: AttendanceSession): Promise<QrTokenDto> {
  await assertCanManageSession(session);
  const settings = await getAttendanceSettings();
  assertMethodEnabled(settings, 'qr');
  if (session.status === 'closed') throw Conflict('Attendance is closed', 'SESSION_CLOSED');
  const { instituteId } = requireTenantContext();
  const rotate = settings.qrRotateSeconds;
  const w = qrWindow(rotate);
  return {
    token: `att1.${session.id}.${w}.${qrSig(instituteId, session, w)}`,
    expiresAt: new Date((w + 1) * rotate * 1000).toISOString(),
    rotateSeconds: rotate,
  };
}

async function sessionFromQr(token: string, settings: AttendanceSettingsDto): Promise<AttendanceSession> {
  const invalid = new AppError(400, 'QR_INVALID', 'This QR code is not valid');
  const m = /^att1\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(token.trim());
  if (!m) throw invalid;
  const session = await sessionAnyRepo.findOne({ where: { id: Number(m[1]) } });
  if (!session) throw invalid;
  const { instituteId } = requireTenantContext();
  const w = Number(m[2]);
  if (!safeEqual(m[3], qrSig(instituteId, session, w))) throw invalid;
  const current = qrWindow(settings.qrRotateSeconds);
  if (w > current || w < current - 1) throw new AppError(400, 'QR_EXPIRED', 'QR code expired; scan again');
  return session;
}

export interface CheckInInput {
  method: 'qr' | 'mobile';
  token?: string;
  classSessionId?: number;
  batchId?: number;
  lat?: number;
  lng?: number;
}

/** Student self check-in by rotating QR or mobile (time window + optional geofence). */
export async function checkIn(input: CheckInInput): Promise<CheckInResult> {
  const { userId } = requireTenantContext();
  const settings = await getAttendanceSettings();
  assertMethodEnabled(settings, input.method);
  let session: AttendanceSession;
  if (input.method === 'qr') {
    if (!input.token) throw BadRequest('token is required');
    session = await sessionFromQr(input.token, settings);
  } else {
    session = await resolveSession(
      { classSessionId: input.classSessionId, batchId: input.batchId, date: localDate() },
      { settings },
    );
    if (session.date !== localDate()) throw Conflict('Check-in is only open on the day of class', 'CHECK_IN_CLOSED');
    if (session.startTime) {
      const since = minutesSinceStart(session.date, session.startTime);
      if (since < -settings.checkInOpensMinutes || since > settings.checkInClosesMinutes)
        throw Conflict('Check-in is not open for this class right now', 'CHECK_IN_CLOSED');
    }
  }
  if (session.status === 'closed') throw Conflict('Attendance is closed', 'SESSION_CLOSED');
  if (!userId || !(await rosterStudentIds(session.batchId, session.date)).includes(userId))
    throw Forbidden('You are not enrolled in this batch', 'NOT_ENROLLED');

  const fence = settings.geofences[String(session.branchId)];
  if (settings.requireGeofence && fence) {
    if (input.lat == null || input.lng == null)
      throw new AppError(400, 'LOCATION_REQUIRED', 'Location is required to check in');
    if (distanceMetres({ lat: input.lat, lng: input.lng }, fence) > fence.radiusM)
      throw Forbidden('You are outside the check-in area', 'OUT_OF_GEOFENCE');
  }
  const late =
    session.startTime != null && minutesSinceStart(session.date, session.startTime) > settings.lateAfterMinutes;
  const { record, duplicate } = await applyRecord(session, userId, late ? 'late' : 'present', input.method, {
    overwrite: false,
    markedByUserId: userId,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
  });
  return { status: record.status, duplicate, sessionId: session.id };
}

/** Active batch ids of a student user. */
export async function activeBatchIds(studentUserId: number): Promise<number[]> {
  const rows = await enrolmentRepo.findAll({
    where: { studentUserId, status: 'active' },
    attributes: ['batchId'],
  });
  return [...new Set(rows.map((r) => r.batchId))];
}

/** Today's classes (or batches, in daily mode) the student can check in to. */
export async function checkInOptions() {
  const { userId, instituteId } = requireTenantContext();
  const settings = await getAttendanceSettings();
  const date = localDate();
  const batchIds = await activeBatchIds(userId!);
  if (!batchIds.length) return { date, mode: settings.mode, methods: settings.methods, items: [] };
  const batches = await batchAny.findAll({ where: { id: { [Op.in]: batchIds } }, attributes: ['id', 'name'] });
  const batchName = new Map(batches.map((b) => [b.id, b.name]));
  const sessions = await AttendanceSession.findAll({
    where: { instituteId, batchId: { [Op.in]: batchIds }, date },
  });
  const mine = sessions.length
    ? await AttendanceRecord.findAll({
        where: { instituteId, studentUserId: userId, attendanceSessionId: { [Op.in]: sessions.map((s) => s.id) } },
      })
    : [];
  const myStatus = new Map(mine.map((r) => [r.attendanceSessionId, r.status]));
  const withState = (s: AttendanceSession | undefined, startTime: string | null) => {
    const since = startTime ? minutesSinceStart(date, startTime) : 0;
    const inWindow = !startTime || (since >= -settings.checkInOpensMinutes && since <= settings.checkInClosesMinutes);
    const status = s ? (myStatus.get(s.id) ?? null) : null;
    return {
      attendanceSessionId: s?.id ?? null,
      sessionStatus: s?.status ?? null,
      myStatus: status,
      canCheckIn:
        (settings.methods as string[]).includes('mobile') && inWindow && !status && s?.status !== 'closed',
    };
  };
  if (settings.mode === 'daily') {
    const byBatch = new Map(sessions.filter((s) => s.kind === 'daily').map((s) => [s.batchId, s]));
    return {
      date,
      mode: settings.mode,
      methods: settings.methods,
      items: batchIds.map((id) => ({
        classSessionId: null,
        batchId: id,
        batchName: batchName.get(id) ?? '',
        subjectName: null,
        startTime: null,
        endTime: null,
        ...withState(byBatch.get(id), null),
      })),
    };
  }
  const classes = await classAny.findAll({
    where: { batchId: { [Op.in]: batchIds }, date, status: { [Op.ne]: 'cancelled' } },
    include: [{ model: Subject, as: 'subject', attributes: ['name'] }],
    order: [['startTime', 'ASC']],
  });
  const byClass = new Map(sessions.filter((s) => s.classSessionId).map((s) => [s.classSessionId!, s]));
  return {
    date,
    mode: settings.mode,
    methods: settings.methods,
    items: classes.map((c) => ({
      classSessionId: c.id,
      batchId: c.batchId,
      batchName: batchName.get(c.batchId) ?? '',
      subjectName: c.subject?.name ?? null,
      startTime: c.startTime,
      endTime: c.endTime,
      ...withState(byClass.get(c.id), c.startTime),
    })),
  };
}

/* ------------------------------------------------------------- staff day view */

/** Classes (or batches in daily mode) on a date with their attendance status, for the roster UI. */
export async function dayOverview(date: string, batchId?: number) {
  const settings = await getAttendanceSettings();
  const { userId } = requireTenantContext();
  const all = hasPermission('attendance.edit');
  const myBatchIds = all
    ? null
    : (await batchTeacherRepo.findAll({ where: { teacherUserId: userId }, attributes: ['batchId'] })).map(
        (b) => b.batchId,
      );
  const sessions = await sessionRepo.findAll({ where: { date, ...(batchId ? { batchId } : {}) } });
  const counts = await countsFor(sessions.map((s) => s.id));
  const summary = (s?: AttendanceSession) =>
    s ? { id: s.id, status: s.status, counts: counts.get(s.id) ?? {} } : null;

  if (settings.mode === 'daily') {
    const where: Record<string | symbol, unknown> = { status: { [Op.in]: ['active', 'planned'] } };
    if (batchId) where.id = batchId;
    if (myBatchIds) where.id = batchId ? (myBatchIds.includes(batchId) ? batchId : -1) : { [Op.in]: myBatchIds };
    const batches = await batchScoped.findAll({ where, order: [['name', 'ASC']] });
    const byBatch = new Map(sessions.filter((s) => s.kind === 'daily').map((s) => [s.batchId, s]));
    return {
      date,
      mode: settings.mode,
      items: batches.map((b) => ({
        classSessionId: null,
        batchId: b.id,
        batchName: b.name,
        subjectName: null,
        startTime: null,
        endTime: null,
        attendance: summary(byBatch.get(b.id)),
      })),
    };
  }
  const where: Record<string | symbol, unknown> = { date, status: { [Op.ne]: 'cancelled' } };
  if (batchId) where.batchId = batchId;
  if (myBatchIds)
    where[Op.or] = [
      { teacherUserId: userId },
      { originalTeacherUserId: userId },
      { batchId: { [Op.in]: myBatchIds } },
    ];
  const classes = await classScoped.findAll({
    where,
    include: [
      { model: Batch, as: 'batch', attributes: ['id', 'name'] },
      { model: Subject, as: 'subject', attributes: ['name'] },
    ],
    order: [['startTime', 'ASC']],
  });
  const byClass = new Map(sessions.filter((s) => s.classSessionId).map((s) => [s.classSessionId!, s]));
  return {
    date,
    mode: settings.mode,
    items: classes.map((c) => ({
      classSessionId: c.id,
      batchId: c.batchId,
      batchName: c.batch?.name ?? '',
      subjectName: c.subject?.name ?? null,
      startTime: c.startTime,
      endTime: c.endTime,
      attendance: summary(byClass.get(c.id)),
    })),
  };
}

/* --------------------------------------------------------- cross-module helper */

export interface RecordAttendanceInput extends SessionRef {
  studentUserId: number;
  status?: AttendanceStatus;
  source?: AttendanceRecordSource;
  markedAt?: Date;
  /** Replace an existing mark (default false: the first mark wins). */
  overwrite?: boolean;
  remarks?: string | null;
}

/**
 * Records one student's attendance from another module (e.g. live classroom joins). Needs tenant
 * context (request or job). Validates enrolment; never overwrites an existing mark unless asked.
 */
export async function recordAttendance(input: RecordAttendanceInput) {
  const session = await resolveSession(input);
  if (!(await rosterStudentIds(session.batchId, session.date)).includes(input.studentUserId))
    throw BadRequest('Student is not enrolled in this batch', { studentUserId: input.studentUserId });
  const { record, duplicate } = await applyRecord(
    session,
    input.studentUserId,
    input.status ?? 'present',
    input.source ?? 'live',
    {
      overwrite: input.overwrite ?? false,
      markedAt: input.markedAt,
      markedByUserId: getContext().userId ?? null,
      remarks: input.remarks,
    },
  );
  return { attendanceSessionId: session.id, recordId: record.id, status: record.status, duplicate };
}

/** Looks up a session by id for self-service flows (institute scope, no branch filter). */
export async function findSessionAny(id: number) {
  const s = await sessionAnyRepo.findOne({ where: { id } });
  if (!s) throw NotFound('Attendance session');
  return s;
}
