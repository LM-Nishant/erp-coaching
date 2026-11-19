import { Op } from 'sequelize';
import type { DeviceIngestResult, DevicePinDto, DevicePinTarget } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { getContext, hasPermission, runWithContext } from '../../shared/context';
import { Conflict, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import { deviceUserRepo } from './adms.service';
import {
  acrossBranches,
  assertStudentMappable,
  biometricEnrolmentRepo,
  deleteEnrolment,
  deviceEventRepo,
  deviceRepo,
  reapplyUnmatched,
  upsertEnrolment,
  visibleStudentUserIds,
} from './devices.service';
import { getStaffPunchProvider } from './staff-punches';

/**
 * Device user PINs and who they belong to: one student (attendance enrolment) or one employee (HR).
 * Branch-restricted users see the PINs on their devices and of the people in their branches; a PIN
 * that belongs to someone outside their branches is shown as taken, without saying by whom.
 */

const DAY = 86_400_000;
const MAX_ROWS = 5000;

const chunks = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export async function listDevicePins(): Promise<DevicePinDto[]> {
  const rows = new Map<string, DevicePinDto>();
  const row = (pin: string) => {
    let r = rows.get(pin);
    if (!r) {
      r = {
        pin,
        deviceName: null,
        deviceIds: [],
        student: null,
        employee: null,
        hidden: false,
        unmatchedPunches: 0,
        lastPunchAt: null,
      };
      rows.set(pin, r);
    }
    return r;
  };
  const onDevice = (r: DevicePinDto, deviceId: number | null) => {
    if (deviceId && !r.deviceIds.includes(deviceId)) r.deviceIds.push(deviceId);
  };

  // Users on the devices this user can see, and their unmatched punches.
  const deviceIds = (await deviceRepo.findAll({ attributes: ['id'] })).map((d) => d.id);
  if (deviceIds.length) {
    const users = await deviceUserRepo.findAll({
      where: { deviceId: { [Op.in]: deviceIds } },
      attributes: ['deviceId', 'pin', 'name'],
      order: [['lastSeenAt', 'DESC']],
      limit: MAX_ROWS,
    });
    for (const u of users) {
      const r = row(u.pin);
      r.deviceName ??= u.name;
      onDevice(r, u.deviceId);
    }
    const punches = await deviceEventRepo.findAll({
      where: {
        deviceId: { [Op.in]: deviceIds },
        status: 'unmatched',
        punchedAt: { [Op.gte]: new Date(Date.now() - config.ADMS_BACKFILL_DAYS * DAY) },
      },
      attributes: ['deviceId', 'enrolmentId', 'punchedAt'],
      order: [['punchedAt', 'DESC']],
      limit: MAX_ROWS,
    });
    for (const e of punches) {
      const r = row(e.enrolmentId);
      r.unmatchedPunches++;
      r.lastPunchAt ??= e.punchedAt.toISOString();
      onDevice(r, e.deviceId);
    }
  }

  // Mappings: people in the user's branches are listed; others only mark a listed PIN as taken.
  const taken = new Set<string>();
  const enrolments = await biometricEnrolmentRepo.findAll({
    attributes: ['studentUserId', 'enrolmentId'],
    include: [{ model: User, as: 'student', attributes: ['id', 'name'] }],
  });
  const students = await visibleStudentUserIds(enrolments.map((e) => e.studentUserId));
  for (const e of enrolments) {
    if (students.has(e.studentUserId))
      row(e.enrolmentId).student = { userId: e.studentUserId, name: e.student?.name ?? '' };
    else taken.add(e.enrolmentId);
  }
  const staff = getStaffPunchProvider();
  if (staff) {
    const named = hasPermission('hr.view');
    const visible = new Set<number>();
    for (const s of await staff.findByPins()) {
      visible.add(s.employeeId);
      row(s.pin).employee = { id: s.employeeId, name: named ? s.name : null };
    }
    for (const pins of chunks([...rows.keys()], 1000))
      for (const s of await acrossBranches(() => staff.findByPins(pins)))
        if (!visible.has(s.employeeId)) taken.add(s.pin);
  }
  for (const pin of taken) {
    const r = rows.get(pin);
    if (r) r.hidden = true;
  }

  // Unmapped PINs with punches first, then other unmapped ones, then mapped ones.
  const rank = (r: DevicePinDto) => (r.student || r.employee || r.hidden ? 2 : r.unmatchedPunches ? 0 : 1);
  return [...rows.values()]
    .sort((a, b) => rank(a) - rank(b) || a.pin.localeCompare(b.pin, 'en', { numeric: true }))
    .slice(0, MAX_ROWS);
}

/**
 * Maps a PIN to a student or an employee (moving it from whoever had it), or unmaps it with
 * `target: null`. Everything is checked before anything changes. Then the PIN's unmatched punches
 * within the backfill window are applied to the new owner.
 */
export async function setDevicePin(
  pin: string,
  target: DevicePinTarget | null,
): Promise<{ reapplied: DeviceIngestResult | null }> {
  const staff = getStaffPunchProvider();
  const enrolment = await biometricEnrolmentRepo.findOne({ where: { enrolmentId: pin } });
  const employee = staff ? ((await acrossBranches(() => staff.findByPins([pin])))[0] ?? null) : null;
  const keepStudent =
    !!enrolment && target?.type === 'student' && target.studentUserId === enrolment.studentUserId;
  const keepEmployee = !!employee && target?.type === 'employee' && target.employeeId === employee.employeeId;
  const dropStudent = !!enrolment && !keepStudent;
  const dropEmployee = !!employee && !keepEmployee;

  if (target?.type === 'student') await assertStudentMappable(target.studentUserId);
  if (target?.type === 'employee' || dropEmployee) {
    if (!staff) throw Forbidden('HR is not enabled for this institute', 'MODULE_DISABLED');
    if (!hasPermission('hr.edit')) throw Forbidden('Changing the PINs of employees needs HR edit access');
  }
  if (target?.type === 'employee' && !(await staff!.isVisible(target.employeeId))) throw NotFound('Employee');
  if (dropStudent && !(await visibleStudentUserIds([enrolment.studentUserId])).has(enrolment.studentUserId))
    throw Conflict('This PIN belongs to a student outside your branches', 'PIN_IN_USE');
  if (dropEmployee && !(await staff!.isVisible(employee.employeeId)))
    throw Conflict('This PIN belongs to an employee outside your branches', 'PIN_IN_USE');

  if (dropStudent) await deleteEnrolment(enrolment.id);
  if (dropEmployee) await staff!.setPin(employee.employeeId, null);
  if (target?.type === 'student' && !keepStudent) await upsertEnrolment(target.studentUserId, pin);
  if (target?.type === 'employee' && !keepEmployee) await staff!.setPin(target.employeeId, pin);
  if (dropStudent || dropEmployee || (target && !keepStudent && !keepEmployee))
    await audit({
      action: 'attendance.device-pin.mapped',
      entityType: 'AttendanceDevicePin',
      entityId: pin,
      metadata: {
        pin,
        target,
        before: { studentUserId: enrolment?.studentUserId ?? null, employeeId: employee?.employeeId ?? null },
      },
    });

  // Same context as a device push: punches apply in whichever branch the device is in.
  const reapplied = target
    ? await runWithContext(
        { ...getContext(), system: true, allowedBranchIds: null, activeBranchId: undefined },
        () => reapplyUnmatched([pin]),
      )
    : null;
  return { reapplied };
}
