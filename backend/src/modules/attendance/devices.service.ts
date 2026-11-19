import { Op } from 'sequelize';
import type {
  AttendanceDeviceDto,
  AttendanceStatus,
  DeviceEventStatus,
  DeviceIngestResult,
  DeviceProtocol,
} from '@erp/shared';
import {
  ADMS_SERIAL,
  admsAdapter,
  getBiometricAdapter,
  type BiometricPunch,
} from '../../infrastructure/biometric';
import { randomToken, safeEqual, sha256 } from '../../infrastructure/crypto';
import { config } from '../../infrastructure/config';
import { getContext, requireTenantContext, runWithContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import { BatchStudent, ClassSession } from '../academics/api';
import { Student } from '../students/api';
import { AttendanceDevice, AttendanceEnrolment, DeviceEvent } from './models';
import { getAttendanceSettings } from './settings';
import { activeBatchIds, applyRecord, resolveSession } from './sessions.service';
import { localDate, localHhmm, minutes, minutesSinceStart } from './time';
import { getInstituteTimezone } from '../../shared/timezone';
import { getStaffPunchProvider, type StaffPunchOutcome } from './staff-punches';

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
const studentScoped = new TenantRepository(Student, { entity: 'Student', branchScoped: true });

export const ADMS_ADAPTER = admsAdapter.name;

/** Runs `fn` across every branch of the institute, e.g. to find who holds a PIN in any branch. */
export const acrossBranches = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext({ ...getContext(), allowedBranchIds: null, activeBranchId: undefined }, fn);

/** The student users among `userIds` whose student record is in the current user's branches. */
export async function visibleStudentUserIds(userIds: number[]): Promise<Set<number>> {
  const ctx = requireTenantContext();
  if (!ctx.activeBranchId && ctx.allowedBranchIds === null) return new Set(userIds);
  const visible = new Set<number>();
  for (const ids of chunks([...new Set(userIds)], 500))
    for (const s of await studentScoped.findAll({
      where: { userId: { [Op.in]: ids } },
      attributes: ['userId'],
    }))
      if (s.userId != null) visible.add(s.userId);
  return visible;
}

export const toDeviceDto = (d: AttendanceDevice, apiKey?: string): AttendanceDeviceDto => ({
  id: d.id,
  branchId: d.branchId,
  name: d.name,
  serial: d.serial,
  adapter: d.adapter,
  protocol: d.adapter === ADMS_ADAPTER ? 'adms' : 'api',
  active: d.active,
  lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
  timeZone: d.timeZone ?? null,
  ipAllowlist: d.ipAllowlist ?? [],
  allowHttp: !!d.allowHttp,
  lastIp: d.lastIp ?? null,
  info: d.info ?? null,
  lastError: d.lastError ?? null,
  lastErrorAt: d.lastErrorAt ? d.lastErrorAt.toISOString() : null,
  ...(apiKey ? { apiKey } : {}),
});

/* -------------------------------------------------------------------- devices */

/** Settings that only ADMS devices use (they are identified by serial number instead of a key). */
export interface AdmsDeviceSettings {
  timeZone?: string | null;
  ipAllowlist?: string[];
  allowHttp?: boolean;
}

function assertAdmsSettings(protocol: DeviceProtocol, s: AdmsDeviceSettings) {
  if (protocol === 'adms') return;
  if (s.timeZone || s.ipAllowlist?.length || s.allowHttp)
    throw BadRequest('Time zone, IP allowlist and plain HTTP apply to ADMS devices only');
}

export async function createDevice(
  input: {
    name: string;
    serial: string;
    branchId?: number | null;
    protocol?: DeviceProtocol;
  } & AdmsDeviceSettings,
) {
  const protocol = input.protocol ?? 'api';
  if (input.branchId) deviceRepo.assertBranchAllowed(input.branchId);
  assertAdmsSettings(protocol, input);
  if (protocol === 'adms' && !ADMS_SERIAL.test(input.serial))
    throw BadRequest('Enter the serial number exactly as the device reports it (no spaces)');
  // Serials are globally unique so the public push endpoints can identify the institute.
  if (await AttendanceDevice.count({ where: { serial: input.serial }, tenantBypass: true } as object))
    throw Conflict('A device with this serial is already registered', 'DUPLICATE_SERIAL');
  // ADMS devices never get a usable key: the stored hash is of a random value nobody sees.
  const apiKey = randomToken(24);
  const d = await deviceRepo.create({
    name: input.name,
    serial: input.serial,
    branchId: input.branchId ?? null,
    adapter: protocol === 'adms' ? ADMS_ADAPTER : getBiometricAdapter().name,
    apiKeyHash: sha256(apiKey),
    ...(protocol === 'adms'
      ? {
          timeZone: input.timeZone ?? null,
          ipAllowlist: input.ipAllowlist?.length ? input.ipAllowlist : null,
          allowHttp: input.allowHttp ?? false,
        }
      : {}),
  });
  await audit({
    action: 'attendance.device.created',
    entityType: 'AttendanceDevice',
    entityId: d.id,
    metadata: { after: toDeviceDto(d) },
  });
  return toDeviceDto(d, protocol === 'api' ? apiKey : undefined);
}

export async function updateDevice(
  id: number,
  patch: { name?: string; active?: boolean; branchId?: number | null } & AdmsDeviceSettings,
) {
  const d = await deviceRepo.findById(id);
  deviceRepo.assertRowWritable(d);
  deviceRepo.assertBranchAssignable(patch.branchId);
  const before = toDeviceDto(d);
  assertAdmsSettings(before.protocol, patch);
  const { ipAllowlist, ...rest } = patch;
  // Saving the device acknowledges the last push error shown with it.
  await d.update({
    ...rest,
    ...(ipAllowlist ? { ipAllowlist: ipAllowlist.length ? ipAllowlist : null } : {}),
    lastError: null,
    lastErrorAt: null,
  });
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
  if (d.adapter === ADMS_ADAPTER)
    throw BadRequest('ADMS devices are identified by serial number and have no API key');
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
 * ADMS devices push through `/iclock` and cannot use the key-based API.
 */
export async function authenticateDevice(serial: string, apiKey: string): Promise<AttendanceDevice | null> {
  if (!serial || !apiKey) return null;
  const d = await AttendanceDevice.findOne({ where: { serial }, tenantBypass: true } as object);
  if (!d || !d.active || d.adapter === ADMS_ADAPTER || !safeEqual(sha256(apiKey), d.apiKeyHash)) return null;
  return d;
}

/* ----------------------------------------------------------------- enrolments */

export async function listEnrolments() {
  const rows = await biometricEnrolmentRepo.findAll({
    include: [{ model: User, as: 'student', attributes: ['id', 'name'] }],
    order: [['enrolmentId', 'ASC']],
  });
  const visible = await visibleStudentUserIds(rows.map((r) => r.studentUserId));
  return rows
    .filter((r) => visible.has(r.studentUserId))
    .map((r) => ({
      id: r.id,
      studentUserId: r.studentUserId,
      studentName: r.student?.name ?? '',
      enrolmentId: r.enrolmentId,
    }));
}

/** Students a branch-restricted user can map: enrolled in a batch and in their branches. */
export async function assertStudentMappable(studentUserId: number): Promise<void> {
  if (!(await batchStudentRepo.count({ studentUserId }))) throw NotFound('Student');
  if (!(await visibleStudentUserIds([studentUserId])).has(studentUserId)) throw NotFound('Student');
}

/**
 * Maps a student to their device enrolment id (one per student, unique in the institute). A PIN
 * belongs to one person, so PINs mapped to an employee (HR) are refused.
 */
export async function upsertEnrolment(studentUserId: number, enrolmentId: string) {
  await assertStudentMappable(studentUserId);
  const clash = await biometricEnrolmentRepo.findOne({
    where: { enrolmentId, studentUserId: { [Op.ne]: studentUserId } },
  });
  if (clash) throw Conflict('This enrolment id is already mapped to another student', 'DUPLICATE_ENROLMENT');
  const staff = getStaffPunchProvider();
  if (staff && (await acrossBranches(() => staff.findByPins([enrolmentId]))).length)
    throw Conflict('This enrolment id is already mapped to an employee', 'DUPLICATE_ENROLMENT');
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
  if (!(await visibleStudentUserIds([row.studentUserId])).has(row.studentUserId))
    throw NotFound('Biometric enrolment');
  await row.destroy();
  await audit({
    action: 'attendance.enrolment.deleted',
    entityType: 'AttendanceEnrolment',
    entityId: id,
    metadata: { studentUserId: row.studentUserId, enrolmentId: row.enrolmentId },
  });
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

const chunks = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export interface IngestOptions {
  /** Punches later than this are stored as ignored: the device clock is ahead. */
  notAfter?: Date;
}

const emptyResult = (received = 0): DeviceIngestResult => ({
  received,
  applied: 0,
  duplicate: 0,
  unmatched: 0,
  noSession: 0,
  ignored: 0,
});

interface PendingPunch {
  p: BiometricPunch & { enrolmentId: string };
  dedupeKey: string;
  /** Stored unmatched event being applied again (after its PIN was mapped). */
  eventId?: number;
}

/**
 * Ingests biometric punches for the current institute. Each punch is stored once (dedupe on
 * serial + enrolment + time); repeated pushes are reported as duplicates. Automatic marks never
 * overwrite a teacher's mark. PINs mapped to employees (HR) feed staff attendance instead.
 */
export async function ingestPunches(
  device: AttendanceDevice,
  punches: BiometricPunch[],
  opts: IngestOptions = {},
): Promise<DeviceIngestResult> {
  const { instituteId } = requireTenantContext();
  for (const p of punches) {
    if (!(p.punchedAt instanceof Date) || Number.isNaN(p.punchedAt.getTime()) || !p.enrolmentId)
      throw BadRequest('Invalid punch', { punch: p });
    if (p.deviceSerial && p.deviceSerial !== device.serial)
      throw BadRequest('Punch is from a different device', { deviceSerial: p.deviceSerial });
  }
  const result = emptyResult(punches.length);

  // Drop punches already stored (or repeated in this batch) before doing any work for them.
  const keyed = punches.map((p) => ({
    p: { ...p, enrolmentId: String(p.enrolmentId) },
    dedupeKey: sha256(`${device.serial}|${p.enrolmentId}|${p.punchedAt.toISOString()}`),
  }));
  const stored = new Set<string>();
  for (const keys of chunks([...new Set(keyed.map((k) => k.dedupeKey))], 500))
    for (const e of await DeviceEvent.findAll({
      where: { instituteId, dedupeKey: { [Op.in]: keys } },
      attributes: ['dedupeKey'],
    }))
      stored.add(e.dedupeKey);
  const fresh = keyed.filter((k) => {
    if (stored.has(k.dedupeKey)) return false;
    stored.add(k.dedupeKey);
    return true;
  });
  result.duplicate += keyed.length - fresh.length;
  await applyPunches(device, fresh, opts, result);
  await device.update({ lastSeenAt: new Date() });
  return result;
}

/**
 * Applies the punches stored as unmatched in the last `ADMS_BACKFILL_DAYS` days for these PINs,
 * once they are mapped to a student or employee. Their events are updated in place.
 */
export async function reapplyUnmatched(pins: string[]): Promise<DeviceIngestResult> {
  const { instituteId } = requireTenantContext();
  const events = pins.length
    ? await DeviceEvent.findAll({
        where: {
          instituteId,
          enrolmentId: { [Op.in]: pins },
          status: 'unmatched',
          deviceId: { [Op.ne]: null },
          punchedAt: { [Op.gte]: new Date(Date.now() - config.ADMS_BACKFILL_DAYS * 86_400_000) },
        },
        order: [['punchedAt', 'ASC']],
        limit: 2000,
      })
    : [];
  const result = emptyResult(events.length);
  const byDevice = new Map<number, DeviceEvent[]>();
  for (const e of events) byDevice.set(e.deviceId!, [...(byDevice.get(e.deviceId!) ?? []), e]);
  for (const [deviceId, list] of byDevice) {
    const device = await AttendanceDevice.findOne({ where: { id: deviceId, instituteId } });
    if (!device) {
      result.unmatched += list.length;
      continue;
    }
    const pending: PendingPunch[] = list.map((e) => ({
      p: {
        deviceSerial: device.serial,
        enrolmentId: e.enrolmentId,
        punchedAt: e.punchedAt,
        direction: e.direction === 'in' || e.direction === 'out' ? (e.direction as 'in' | 'out') : undefined,
      },
      dedupeKey: e.dedupeKey,
      eventId: e.id,
    }));
    await applyPunches(device, pending, {}, result);
  }
  return result;
}

/** Decides what each punch is (student or staff attendance, or why not), applies it and stores it. */
async function applyPunches(
  device: AttendanceDevice,
  fresh: PendingPunch[],
  opts: IngestOptions,
  result: DeviceIngestResult,
): Promise<void> {
  const { instituteId } = requireTenantContext();
  const settings = await getAttendanceSettings();
  const tz = await getInstituteTimezone();

  // PINs mapped to students take precedence; the rest may belong to employees.
  const pins = [...new Set(fresh.map((k) => k.p.enrolmentId))];
  const enrolments = new Map<string, AttendanceEnrolment>();
  for (const list of chunks(pins, 500))
    for (const e of await biometricEnrolmentRepo.findAll({ where: { enrolmentId: { [Op.in]: list } } }))
      enrolments.set(e.enrolmentId, e);
  const provider = getStaffPunchProvider();
  const staffPins = pins.filter((pin) => !enrolments.has(pin));
  const staff = new Map(
    (provider && staffPins.length ? await provider.findByPins(staffPins) : []).map((s) => [s.pin, s]),
  );
  const isFuture = (p: BiometricPunch) => !!opts.notAfter && p.punchedAt > opts.notAfter;
  const staffPunches = fresh.filter((k) => staff.has(k.p.enrolmentId) && !isFuture(k.p));
  const staffOutcomes = new Map<string, StaffPunchOutcome>();
  if (provider && staffPunches.length) {
    const { outcomes } = await provider.ingest(
      staffPunches.map((k) => ({
        employeeId: staff.get(k.p.enrolmentId)!.employeeId,
        punchedAt: k.p.punchedAt,
      })),
    );
    staffPunches.forEach((k, i) => staffOutcomes.set(k.dedupeKey, outcomes[i] ?? 'unknown'));
  }

  for (const { p, dedupeKey, eventId } of fresh) {
    let status: DeviceEventStatus = 'applied';
    let studentUserId: number | null = null;
    let recordId: number | null = null;
    let note: string | null = null;
    const enrolment = enrolments.get(p.enrolmentId);
    const staffOutcome = staffOutcomes.get(dedupeKey);
    if (isFuture(p)) {
      status = 'ignored';
      note = 'Punch time is in the future; check the device clock';
    } else if (staffOutcome) {
      status = staffOutcome === 'applied' ? 'applied' : staffOutcome === 'skipped' ? 'ignored' : 'unmatched';
      note =
        staffOutcome === 'applied'
          ? 'Staff attendance'
          : staffOutcome === 'skipped'
            ? 'Staff attendance for this day was recorded manually or as leave'
            : 'Unknown enrolment id';
    } else if (!(settings.methods as string[]).includes('biometric')) {
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
    if (eventId) {
      // Conditional: a concurrent re-apply of the same event counts it once.
      const [changed] = await DeviceEvent.update(
        { status, studentUserId, attendanceRecordId: recordId, note },
        { where: { instituteId, id: eventId, status: 'unmatched' } },
      );
      if (!changed && status !== 'unmatched') {
        result.duplicate++;
        continue;
      }
    } else {
      try {
        await DeviceEvent.create({
          instituteId,
          branchId: device.branchId,
          deviceId: device.id,
          deviceSerial: device.serial,
          enrolmentId: p.enrolmentId,
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
    }
    if (status === 'applied') result.applied++;
    else if (status === 'duplicate') result.duplicate++;
    else if (status === 'unmatched') result.unmatched++;
    else if (status === 'no_session') result.noSession++;
    else result.ignored++;
  }
}

export async function parseDevicePayload(payload: unknown) {
  return getBiometricAdapter().parsePush(payload, { timeZone: await getInstituteTimezone() });
}
