import { Op } from 'sequelize';
import type {
  AttendanceCorrectionDto,
  AttendanceStatus,
  NotificationEventDef,
  StudentLeaveRequestDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import { Batch, BatchTeacher } from '../academics/api';
import { getLinkedStudentUsers } from '../guardians/guardian-access';
import { notify } from '../notifications/api';
import { AttendanceCorrection, AttendanceRecord, AttendanceSession, StudentLeaveRequest } from './models';
import { getAttendanceSettings } from './settings';
import {
  activeBatchIds,
  applyRecord,
  canManageSession,
  findSessionAny,
  rosterStudentIds,
} from './sessions.service';
import { addDays, localDate } from './time';

export const ATTENDANCE_EVENTS: NotificationEventDef[] = [
  {
    key: 'attendance.correction-decided',
    label: 'Attendance correction decided',
    category: 'Attendance',
    variables: ['student.name', 'date', 'status', 'decision', 'note'],
    title: 'Attendance correction {{decision}}',
    body: 'The correction for {{student.name}} on {{date}} ({{status}}) was {{decision}}. {{note}}',
    defaultChannels: ['in_app', 'push'],
    defaultRecipientTypes: ['user'],
  },
  {
    key: 'attendance.leave-decided',
    label: 'Student leave request decided',
    category: 'Attendance',
    variables: ['student.name', 'fromDate', 'toDate', 'decision', 'note'],
    title: 'Leave request {{decision}}',
    body: 'Leave for {{student.name}} from {{fromDate}} to {{toDate}} was {{decision}}. {{note}}',
    defaultChannels: ['in_app', 'push'],
    defaultRecipientTypes: ['user'],
  },
];

export const correctionRepo = new TenantRepository(AttendanceCorrection, {
  entity: 'Correction request',
  branchScoped: true,
});
const correctionAnyRepo = new TenantRepository(AttendanceCorrection, { entity: 'Correction request' });
export const leaveRepo = new TenantRepository(StudentLeaveRequest, {
  entity: 'Leave request',
  branchScoped: true,
});
const leaveAnyRepo = new TenantRepository(StudentLeaveRequest, { entity: 'Leave request' });
const batchTeacherRepo = new TenantRepository(BatchTeacher, { entity: 'Batch teacher' });

/* ------------------------------------------------------------------- identity */

/**
 * Whose attendance the caller acts on: themselves (student) or a linked child (parent).
 * Unlinked student ids are 404 so they can't be probed.
 */
export async function resolveSubject(
  studentUserId?: number,
): Promise<{ studentUserId: number; as: 'student' | 'parent' }> {
  const { userId } = requireTenantContext();
  if (!userId) throw Forbidden();
  if (!studentUserId || studentUserId === userId) return { studentUserId: userId, as: 'student' };
  const children = await getLinkedStudentUsers(userId);
  if (!children.some((c) => c.id === studentUserId)) throw NotFound('Student');
  return { studentUserId, as: 'parent' };
}

/** Student user ids the caller may view: themselves plus linked children. */
export async function selfAndChildren(): Promise<number[]> {
  const { userId } = requireTenantContext();
  const children = await getLinkedStudentUsers(userId!);
  return [userId!, ...children.map((c) => c.id)];
}

async function names(ids: number[]) {
  const users = ids.length
    ? await User.findAll({ where: { id: [...new Set(ids)] }, attributes: ['id', 'name'] })
    : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

/* ---------------------------------------------------------------- corrections */

export function toCorrectionDto(c: AttendanceCorrection, name?: string): AttendanceCorrectionDto {
  return {
    id: c.id,
    attendanceSessionId: c.attendanceSessionId,
    studentUserId: c.studentUserId,
    studentName: name ?? c.student?.name,
    date: c.session?.date,
    batchName: c.session?.batch?.name,
    requestedByUserId: c.requestedByUserId,
    currentStatus: c.currentStatus,
    requestedStatus: c.requestedStatus,
    reason: c.reason,
    status: c.status,
    decidedByUserId: c.decidedByUserId,
    decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null,
    decisionNote: c.decisionNote,
    createdAt: c.createdAt.toISOString(),
  };
}

const correctionInclude = [
  { model: User, as: 'student', attributes: ['id', 'name'] },
  {
    model: AttendanceSession,
    as: 'session',
    attributes: ['id', 'date', 'batchId', 'teacherUserId'],
    include: [{ model: Batch, as: 'batch', attributes: ['name'] }],
  },
];

async function applyCorrection(c: AttendanceCorrection, session: AttendanceSession, byUserId: number) {
  await getSequelize().transaction(async (transaction) => {
    await applyRecord(session, c.studentUserId, c.requestedStatus, 'correction', {
      overwrite: true,
      markedByUserId: byUserId,
      remarks: `Correction #${c.id}`,
      transaction,
    });
    await c.update({ status: 'approved', decidedByUserId: byUserId, decidedAt: new Date() }, { transaction });
  });
}

export async function createCorrection(input: {
  attendanceSessionId: number;
  studentUserId?: number;
  requestedStatus: AttendanceStatus;
  reason: string;
}) {
  const { userId, instituteId } = requireTenantContext();
  const settings = await getAttendanceSettings();
  const subject = await resolveSubject(input.studentUserId);
  if (subject.as === 'parent' && !settings.parentCorrections)
    throw Forbidden('Parents cannot raise attendance corrections', 'PARENT_CORRECTIONS_DISABLED');
  const session = await findSessionAny(input.attendanceSessionId);
  const record = await AttendanceRecord.findOne({
    where: { instituteId, attendanceSessionId: session.id, studentUserId: subject.studentUserId },
  });
  if (!record && !(await rosterStudentIds(session.batchId, session.date)).includes(subject.studentUserId))
    throw NotFound('Attendance session');
  if (session.date < addDays(localDate(), -settings.correctionWindowDays))
    throw Conflict(
      `Corrections can be requested up to ${settings.correctionWindowDays} days after the class`,
      'CORRECTION_WINDOW_CLOSED',
    );
  if (record?.status === input.requestedStatus) throw BadRequest('Attendance already has this status');
  const pending = await correctionAnyRepo.count({
    attendanceSessionId: session.id,
    studentUserId: subject.studentUserId,
    status: 'pending',
  });
  if (pending) throw Conflict('A correction for this class is already pending', 'CORRECTION_PENDING');
  const c = await correctionAnyRepo.create({
    branchId: session.branchId,
    attendanceSessionId: session.id,
    studentUserId: subject.studentUserId,
    requestedByUserId: userId!,
    currentStatus: record?.status ?? null,
    requestedStatus: input.requestedStatus,
    reason: input.reason,
  });
  if (settings.correctionApproval === 'auto') await applyCorrection(c, session, userId!);
  await audit({
    action: 'attendance.correction.requested',
    entityType: 'AttendanceCorrection',
    entityId: c.id,
    metadata: { after: c.toJSON(), autoApproved: settings.correctionApproval === 'auto' },
  });
  return toCorrectionDto(c, (await names([c.studentUserId])).get(c.studentUserId));
}

/** Staff list: approvers see their branches; teachers see corrections for their classes/batches. */
export async function listCorrections(filter: { status?: string; page: number; pageSize: number }) {
  const { userId } = requireTenantContext();
  const where: Record<string | symbol, unknown> = {};
  if (filter.status) where.status = filter.status;
  const settings = await getAttendanceSettings();
  if (!hasPermission('attendance.approve') && !hasPermission('attendance.edit')) {
    if (settings.correctionApproval !== 'teacher') return { rows: [], count: 0 };
    const myBatches = (
      await batchTeacherRepo.findAll({ where: { teacherUserId: userId }, attributes: ['batchId'] })
    ).map((b) => b.batchId);
    where[Op.or] = [
      { '$session.teacher_user_id$': userId },
      { '$session.batch_id$': { [Op.in]: myBatches.length ? myBatches : [0] } },
    ];
  }
  return correctionRepo.findAndCountAll({
    where,
    include: correctionInclude,
    order: [['createdAt', 'DESC']],
    limit: filter.pageSize,
    offset: (filter.page - 1) * filter.pageSize,
  });
}

export async function listMyCorrections() {
  const { userId } = requireTenantContext();
  const ids = await selfAndChildren();
  return correctionAnyRepo.findAll({
    where: { [Op.or]: [{ requestedByUserId: userId }, { studentUserId: { [Op.in]: ids } }] },
    include: correctionInclude,
    order: [['createdAt', 'DESC']],
    limit: 100,
  });
}

export async function decideCorrection(id: number, approve: boolean, note: string | null) {
  const { userId } = requireTenantContext();
  const c = await correctionRepo.findById(id, { include: correctionInclude });
  if (c.status !== 'pending') throw Conflict(`Request is already ${c.status}`, 'NOT_PENDING');
  const settings = await getAttendanceSettings();
  const session = await findSessionAny(c.attendanceSessionId);
  const allowed =
    hasPermission('attendance.approve') ||
    (settings.correctionApproval === 'teacher' && (await canManageSession(session)));
  if (!allowed) throw Forbidden('You cannot decide this correction', 'NOT_APPROVER');
  if (approve) await applyCorrection(c, session, userId!);
  else await c.update({ status: 'rejected', decidedByUserId: userId!, decidedAt: new Date() });
  if (note) await c.update({ decisionNote: note });
  await audit({
    action: approve ? 'attendance.correction.approved' : 'attendance.correction.rejected',
    entityType: 'AttendanceCorrection',
    entityId: c.id,
    metadata: { before: { status: 'pending' }, after: { status: c.status, note } },
  });
  await notify({
    event: 'attendance.correction-decided',
    recipients: [{ userIds: [c.requestedByUserId], type: 'user' }],
    data: {
      student: { name: c.student?.name ?? '' },
      date: session.date,
      status: c.requestedStatus,
      decision: c.status,
      note: note ?? '',
    },
    branchId: c.branchId,
  });
  return toCorrectionDto(c);
}

export async function cancelCorrection(id: number) {
  const { userId } = requireTenantContext();
  const c = await correctionAnyRepo.findOne({ where: { id, requestedByUserId: userId } });
  if (!c) throw NotFound('Correction request');
  if (c.status !== 'pending') throw Conflict(`Request is already ${c.status}`, 'NOT_PENDING');
  await c.update({ status: 'cancelled' });
  await audit({
    action: 'attendance.correction.cancelled',
    entityType: 'AttendanceCorrection',
    entityId: id,
  });
  return toCorrectionDto(c);
}

/* --------------------------------------------------------------------- leaves */

export function toLeaveDto(l: StudentLeaveRequest, name?: string): StudentLeaveRequestDto {
  return {
    id: l.id,
    studentUserId: l.studentUserId,
    studentName: name ?? l.student?.name,
    requestedByUserId: l.requestedByUserId,
    fromDate: l.fromDate,
    toDate: l.toDate,
    reason: l.reason,
    status: l.status,
    decidedByUserId: l.decidedByUserId,
    decidedAt: l.decidedAt ? l.decidedAt.toISOString() : null,
    decisionNote: l.decisionNote,
    createdAt: l.createdAt.toISOString(),
  };
}

const MAX_LEAVE_DAYS = 60;

export async function createLeave(input: {
  studentUserId?: number;
  fromDate: string;
  toDate: string;
  reason: string;
}) {
  const { userId } = requireTenantContext();
  const subject = await resolveSubject(input.studentUserId);
  if (input.toDate < input.fromDate) throw BadRequest('toDate must be on or after fromDate');
  if (input.toDate > addDays(input.fromDate, MAX_LEAVE_DAYS - 1))
    throw BadRequest(`Leave can span at most ${MAX_LEAVE_DAYS} days`);
  const batchIds = await activeBatchIds(subject.studentUserId);
  const batch = batchIds.length
    ? await Batch.findOne({
        where: { instituteId: requireTenantContext().instituteId, id: batchIds[0] },
        attributes: ['branchId'],
      })
    : null;
  if (!batch) throw new AppError(400, 'NOT_ENROLLED', 'The student is not enrolled in any batch');
  const overlap = await leaveAnyRepo.count({
    studentUserId: subject.studentUserId,
    status: { [Op.in]: ['pending', 'approved'] },
    fromDate: { [Op.lte]: input.toDate },
    toDate: { [Op.gte]: input.fromDate },
  });
  if (overlap) throw Conflict('An overlapping leave request exists', 'LEAVE_OVERLAP');
  const l = await leaveAnyRepo.create({
    branchId: batch.branchId,
    studentUserId: subject.studentUserId,
    requestedByUserId: userId!,
    fromDate: input.fromDate,
    toDate: input.toDate,
    reason: input.reason,
  });
  await audit({
    action: 'attendance.leave.requested',
    entityType: 'StudentLeaveRequest',
    entityId: l.id,
    metadata: { after: l.toJSON() },
  });
  return toLeaveDto(l, (await names([l.studentUserId])).get(l.studentUserId));
}

export async function listMyLeaves() {
  const { userId } = requireTenantContext();
  const ids = await selfAndChildren();
  return leaveAnyRepo.findAll({
    where: { [Op.or]: [{ requestedByUserId: userId }, { studentUserId: { [Op.in]: ids } }] },
    include: [{ model: User, as: 'student', attributes: ['id', 'name'] }],
    order: [['fromDate', 'DESC']],
    limit: 100,
  });
}

/** Approving converts the student's absent marks in the range to leave; later rosters close as leave. */
export async function decideLeave(id: number, approve: boolean, note: string | null) {
  const { userId, instituteId } = requireTenantContext();
  const l = await leaveRepo.findById(id, {
    include: [{ model: User, as: 'student', attributes: ['id', 'name'] }],
  });
  if (l.status !== 'pending') throw Conflict(`Request is already ${l.status}`, 'NOT_PENDING');
  let converted = 0;
  await getSequelize().transaction(async (transaction) => {
    if (approve) {
      const [n] = await AttendanceRecord.update(
        { status: 'leave', source: 'leave', markedByUserId: userId!, markedAt: new Date() },
        {
          where: {
            instituteId,
            studentUserId: l.studentUserId,
            status: 'absent',
            date: { [Op.between]: [l.fromDate, l.toDate] },
          },
          transaction,
        },
      );
      converted = n;
    }
    await l.update(
      {
        status: approve ? 'approved' : 'rejected',
        decidedByUserId: userId!,
        decidedAt: new Date(),
        decisionNote: note,
      },
      { transaction },
    );
  });
  await audit({
    action: approve ? 'attendance.leave.approved' : 'attendance.leave.rejected',
    entityType: 'StudentLeaveRequest',
    entityId: l.id,
    metadata: {
      before: { status: 'pending' },
      after: { status: l.status, note },
      convertedRecords: converted,
    },
  });
  await notify({
    event: 'attendance.leave-decided',
    recipients: [{ userIds: [l.requestedByUserId], type: 'user' }],
    data: {
      student: { name: l.student?.name ?? '' },
      fromDate: l.fromDate,
      toDate: l.toDate,
      decision: l.status,
      note: note ?? '',
    },
    branchId: l.branchId,
  });
  return { ...toLeaveDto(l), convertedRecords: converted };
}

export async function cancelLeave(id: number) {
  const { userId } = requireTenantContext();
  const l = await leaveAnyRepo.findOne({ where: { id, requestedByUserId: userId } });
  if (!l) throw NotFound('Leave request');
  if (l.status !== 'pending') throw Conflict(`Request is already ${l.status}`, 'NOT_PENDING');
  await l.update({ status: 'cancelled' });
  await audit({ action: 'attendance.leave.cancelled', entityType: 'StudentLeaveRequest', entityId: id });
  return toLeaveDto(l);
}
