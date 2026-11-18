import { Op } from 'sequelize';
import type {
  AttendanceDeviceDto,
  AttendanceStatus,
  DeviceEventStatus,
  DeviceIngestResult,
} from '@erp/shared';
import { getBiometricAdapter, type BiometricPunch } from '../../infrastructure/biometric';
import { randomToken, safeEqual, sha256 } from '../../infrastructure/crypto';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import { BatchStudent, ClassSession } from '../academics/api';
import { AttendanceDevice, AttendanceEnrolment, DeviceEvent } from './models';
import { getAttendanceSettings } from './settings';
import { activeBatchIds, applyRecord, resolveSession } from './sessions.service';
import { localDate, localHhmm, minutes, minutesSinceStart } from './time';
import { getInstituteTimezone } from '../../shared/timezone';

export const deviceRepo = new TenantRepository(AttendanceDevice, {
  entity: 'Device',
  branchScoped: true,
  instituteWideRows: true,
});
export const biometricEnrolmentRepo = new TenantRepository(AttendanceEnrolment, {
  entity: 'Biometric enrolment',
});
export const deviceEventRepo = new TenantRepository(DeviceEvent, { entity: 'Device event' });
const batchStudentRepo = new TenantRepository(BatchStudent, { entity: 'Enrollment' });
const classAny = new TenantRepository(ClassSession, { entity: 'Class session' });

export const toDeviceDto = (d: AttendanceDevice, apiKey?: string): AttendanceDeviceDto => ({
  id: d.id,
  branchId: d.branchId,
  name: d.name,
  serial: d.serial,
  adapter: d.adapter,
  active: d.active,
  lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
  ...(apiKey ? { apiKey } : {}),
});

/* -------------------------------------------------------------------- devices */

export async function createDevice(input: { name: string; serial: string; branchId?: number | null }) {
  if (input.branchId) deviceRepo.assertBranchAllowed(input.branchId);
  // Serials are globally unique so the public push endpoint can identify the institute.
  if (await AttendanceDevice.count({ where: { serial: input.serial }, tenantBypass: true } as object))
    throw Conflict('A device with this serial is already registered', 'DUPLICATE_SERIAL');
  const apiKey = randomToken(24);
  const d = await deviceRepo.create({
    name: input.name,
    serial: input.serial,
    branchId: input.branchId ?? null,
    adapter: getBiometricAdapter().name,
    apiKeyHash: sha256(apiKey),
  });
  await audit({
    action: 'attendance.device.created',
    entityType: 'AttendanceDevice',
    entityId: d.id,
    metadata: { after: toDeviceDto(d) },
  });
  return toDeviceDto(d, apiKey);
}

export async function updateDevice(
  id: number,
  patch: { name?: string; active?: boolean; branchId?: number | null },
) {
  const d = await deviceRepo.findById(id);
  deviceRepo.assertRowWritable(d);
  deviceRepo.assertBranchAssignable(patch.branchId);
  const before = toDeviceDto(d);
  await d.update(patch);
  await audit({
    action: 'attendance.device.updated',
    entityType: 'AttendanceDevice',
    entityId: id,
    metadata: { before, after: toDeviceDto(d) },
  });
  return toDeviceDto(d);
}

export async function rotateDeviceKey(id: number) {
  const d = await deviceRepo.findById(id);
  deviceRepo.assertRowWritable(d);
  const apiKey = randomToken(24);
  await d.update({ apiKeyHash: sha256(apiKey) });
  await audit({ action: 'attendance.device.key-rotated', entityType: 'AttendanceDevice', entityId: id });
  return toDeviceDto(d, apiKey);
}

export async function deleteDevice(id: number) {
  const d = await deviceRepo.destroy(id);
  await audit({
    action: 'attendance.device.deleted',
    entityType: 'AttendanceDevice',
    entityId: id,
    metadata: { before: toDeviceDto(d) },
  });
}

/**
 * Public push: identifies the device (and so the institute) by serial + API key. Runs before any
 * tenant context exists, hence the bypass; only the matching institute's data is touched afterwards.
 */
export async function authenticateDevice(serial: string, apiKey: string): Promise<AttendanceDevice | null> {
  if (!serial || !apiKey) return null;
  const d = await AttendanceDevice.findOne({ where: { serial }, tenantBypass: true } as object);
  if (!d || !d.active || !safeEqual(sha256(apiKey), d.apiKeyHash)) return null;
  return d;
}

/* ----------------------------------------------------------------- enrolments */

export async function listEnrolments() {
  const rows = await biometricEnrolmentRepo.findAll({
    include: [{ model: User, as: 'student', attributes: ['id', 'name'] }],
    order: [['enrolmentId', 'ASC']],
  });
  return rows.map((r) => ({
    id: r.id,
    studentUserId: r.studentUserId,
    studentName: r.student?.name ?? '',
    enrolmentId: r.enrolmentId,
  }));
}

/** Maps a student to their device enrolment id (one per student, unique in the institute). */
export async function upsertEnrolment(studentUserId: number, enrolmentId: string) {
  if (!(await batchStudentRepo.count({ studentUserId }))) throw NotFound('Student');
  const clash = await biometricEnrolmentRepo.findOne({
    where: { enrolmentId, studentUserId: { [Op.ne]: studentUserId } },
  });
  if (clash) throw Conflict('This enrolment id is already mapped to another student', 'DUPLICATE_ENROLMENT');
  const existing = await biometricEnrolmentRepo.findOne({ where: { studentUserId } });
  const row = existing
    ? await existing.update({ enrolmentId })
    : await biometricEnrolmentRepo.create({ studentUserId, enrolmentId });
  await audit({
    action: 'attendance.enrolment.saved',
    entityType: 'AttendanceEnrolment',
    entityId: row.id,
    metadata: { studentUserId, enrolmentId, before: existing ? existing.previous('enrolmentId') : null },
  });
  return { id: row.id, studentUserId, enrolmentId };
}

export async function deleteEnrolment(id: number) {
  const row = await biometricEnrolmentRepo.findById(id);
  await row.destroy();
  await audit({ action: 'attendance.enrolment.deleted', entityType: 'AttendanceEnrolment', entityId: id });
}

/* --------------------------------------------------------------------- ingest */

export async function listDeviceEvents(filter: {
  status?: DeviceEventStatus;
  page: number;
  pageSize: number;
}) {
  return deviceEventRepo.findAndCountAll({
    where: filter.status ? { status: filter.status } : {},
    order: [['punchedAt', 'DESC']],
    limit: filter.pageSize,
    offset: (filter.page - 1) * filter.pageSize,
  });
}

/** Classes (class mode) whose check-in window contains the punch; daily mode → batch-days. */
async function targetSessions(studentUserId: number, at: Date, branchId: number | null) {
  const settings = await getAttendanceSettings();
  const tz = await getInstituteTimezone();
  const date = localDate(tz, at);
  const batchIds = await activeBatchIds(studentUserId);
  if (!batchIds.length) return [];
  if (settings.mode === 'daily') {
    const sessions = [];
    for (const batchId of batchIds) {
      const s = await resolveSession({ batchId, date }, { settings });
      if (!branchId || s.branchId === branchId)
        sessions.push({ session: s, startTime: null as string | null });
    }
    return sessions;
  }
  const t = minutes(localHhmm(at, tz));
  const classes = await classAny.findAll({
    where: {
      batchId: { [Op.in]: batchIds },
      date,
      status: { [Op.ne]: 'cancelled' },
      ...(branchId ? { branchId } : {}),
    },
  });
  const hits = classes.filter((c) => {
    const start = minutes(c.startTime);
    const end = Math.max(minutes(c.endTime), start + settings.checkInClosesMinutes);
    return t >= start - settings.checkInOpensMinutes && t <= end;
  });
  const out = [];
  for (const c of hits)
    out.push({
      session: await resolveSession({ classSessionId: c.id }, { settings }),
      startTime: c.startTime,
    });
  return out;
}

/**
 * Ingests biometric punches for the current institute. Each punch is stored once (dedupe on
 * serial + enrolment + time); repeated pushes are reported as duplicates. Automatic marks never
 * overwrite a teacher's mark.
 */
export async function ingestPunches(
  device: AttendanceDevice,
  punches: BiometricPunch[],
): Promise<DeviceIngestResult> {
  const { instituteId } = requireTenantContext();
  const settings = await getAttendanceSettings();
  const tz = await getInstituteTimezone();
  const result: DeviceIngestResult = {
    received: punches.length,
    applied: 0,
    duplicate: 0,
    unmatched: 0,
    noSession: 0,
    ignored: 0,
  };
  for (const p of punches) {
    if (!(p.punchedAt instanceof Date) || Number.isNaN(p.punchedAt.getTime()) || !p.enrolmentId)
      throw BadRequest('Invalid punch', { punch: p });
    if (p.deviceSerial && p.deviceSerial !== device.serial)
      throw BadRequest('Punch is from a different device', { deviceSerial: p.deviceSerial });
    const dedupeKey = sha256(`${device.serial}|${p.enrolmentId}|${p.punchedAt.toISOString()}`);
    if (await DeviceEvent.count({ where: { instituteId, dedupeKey } })) {
      result.duplicate++;
      continue;
    }
    let status: DeviceEventStatus = 'applied';
    let studentUserId: number | null = null;
    let recordId: number | null = null;
    let note: string | null = null;
    const enrolment = await biometricEnrolmentRepo.findOne({ where: { enrolmentId: String(p.enrolmentId) } });
    if (!(settings.methods as string[]).includes('biometric')) {
      status = 'ignored';
      note = 'Biometric attendance is disabled';
    } else if (p.direction === 'out') {
      status = 'ignored';
      note = 'Out punch';
    } else if (!enrolment) {
      status = 'unmatched';
      note = 'Unknown enrolment id';
    } else {
      studentUserId = enrolment.studentUserId;
      const targets = await targetSessions(studentUserId, p.punchedAt, device.branchId);
      if (!targets.length) {
        status = 'no_session';
        note = 'No class in the check-in window';
      } else {
        let anyApplied = false;
        for (const { session, startTime } of targets) {
          if (session.status === 'closed') continue;
          const late =
            startTime != null &&
            minutesSinceStart(session.date, startTime, tz, p.punchedAt) > settings.lateAfterMinutes;
          const st: AttendanceStatus = late ? 'late' : 'present';
          const r = await applyRecord(session, studentUserId, st, 'biometric', {
            overwrite: false,
            markedAt: p.punchedAt,
          });
          if (!r.duplicate) {
            anyApplied = true;
            recordId ??= r.record.id;
          }
        }
        if (!anyApplied) {
          status = 'duplicate';
          note = 'Attendance already marked or closed';
        }
      }
    }
    try {
      await DeviceEvent.create({
        instituteId,
        branchId: device.branchId,
        deviceId: device.id,
        deviceSerial: device.serial,
        enrolmentId: String(p.enrolmentId),
        punchedAt: p.punchedAt,
        direction: p.direction ?? null,
        dedupeKey,
        status,
        studentUserId,
        attendanceRecordId: recordId,
        note,
      });
    } catch (err) {
      if ((err as Error).name === 'SequelizeUniqueConstraintError') {
        result.duplicate++;
        continue;
      }
      throw err;
    }
    if (status === 'applied') result.applied++;
    else if (status === 'duplicate') result.duplicate++;
    else if (status === 'unmatched') result.unmatched++;
    else if (status === 'no_session') result.noSession++;
    else result.ignored++;
  }
  await device.update({ lastSeenAt: new Date() });
  return result;
}

export async function parseDevicePayload(payload: unknown) {
  return getBiometricAdapter().parsePush(payload, { timeZone: await getInstituteTimezone() });
}
