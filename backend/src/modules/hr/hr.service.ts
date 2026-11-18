import { Op, type Transaction } from 'sequelize';
import type { LeaveBalanceDto, StaffAttendanceStatus } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { getBiometricAdapter } from '../../infrastructure/biometric';
import { getContext, requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { Branch } from '../branches/branch.model';
import { assertWithinLimit } from '../subscriptions/subscription.service';
import {
  Employee,
  EmployeeAsset,
  EmployeeSeparation,
  EmploymentContract,
  LeaveApplication,
  LeaveType,
  Shift,
  StaffAttendance,
} from './models';
import { addDays, daysInclusive, eachDate, today } from './dates';

/** Branch-scoped: branch admins only see staff of their branches. */
export const employeeRepo = new TenantRepository(Employee, { entity: 'Employee', branchScoped: true });
/** Institute-scoped lookup used only for self-service (ownership is checked by user id). */
const employeeSelfRepo = new TenantRepository(Employee, { entity: 'Employee' });
export const shiftRepo = new TenantRepository(Shift, {
  entity: 'Shift',
  branchScoped: true,
  instituteWideRows: true,
});
export const leaveTypeRepo = new TenantRepository(LeaveType, { entity: 'Leave type' });
export const leaveRepo = new TenantRepository(LeaveApplication, { entity: 'Leave application' });
export const attendanceRepo = new TenantRepository(StaffAttendance, { entity: 'Attendance' });
export const contractRepo = new TenantRepository(EmploymentContract, { entity: 'Contract' });
export const assetRepo = new TenantRepository(EmployeeAsset, { entity: 'Asset' });
export const separationRepo = new TenantRepository(EmployeeSeparation, { entity: 'Separation' });

/** Editable defaults created the first time an institute opens leave settings. */
const DEFAULT_LEAVE_TYPES = [
  { code: 'CL', name: 'Casual leave', annualQuota: 12, paid: true, encashable: false },
  { code: 'SL', name: 'Sick leave', annualQuota: 12, paid: true, encashable: false },
  { code: 'EL', name: 'Earned leave', annualQuota: 15, paid: true, encashable: true },
  { code: 'LWP', name: 'Leave without pay', annualQuota: null, paid: false, encashable: false },
];

export async function ensureDefaultLeaveTypes(): Promise<void> {
  if ((await leaveTypeRepo.count()) > 0) return;
  for (const t of DEFAULT_LEAVE_TYPES) await leaveTypeRepo.create(t);
}

/** The employee record linked to the signed-in user (self-service). */
export async function currentEmployee(): Promise<Employee> {
  const { userId } = getContext();
  const emp = userId ? await employeeSelfRepo.findOne({ where: { userId } }) : null;
  if (!emp) throw NotFound('Employee profile for your account');
  return emp;
}

/** Ids of employees the caller may see (branch scope applied). */
export async function visibleEmployeeIds(where: Record<string, unknown> = {}): Promise<number[]> {
  const rows = await employeeRepo.findAll({ where, attributes: ['id'] });
  return rows.map((e) => e.id);
}

export async function assertBranchInInstitute(branchId: number | null | undefined) {
  if (branchId == null) return;
  const { instituteId } = requireTenantContext();
  if (!(await Branch.count({ where: { instituteId, id: branchId } }))) throw BadRequest('Unknown branch');
  employeeRepo.assertBranchAllowed(branchId);
}

/** Teachers counted against the plan's `maxTeachers`: teaching employees that have not exited. */
export function teacherCount(excludeEmployeeId?: number): Promise<number> {
  const where: Record<string | symbol, unknown> = { isTeacher: true, status: { [Op.ne]: 'exited' } };
  if (excludeEmployeeId) where.id = { [Op.ne]: excludeEmployeeId };
  return employeeSelfRepo.count(where);
}

/** Throws PLAN_LIMIT_EXCEEDED when adding (or re-activating) one more teacher would exceed the plan. */
export async function assertTeacherSeat(excludeEmployeeId?: number): Promise<void> {
  const { instituteId } = requireTenantContext();
  await assertWithinLimit(instituteId, 'maxTeachers', await teacherCount(excludeEmployeeId));
}

export async function nextEmployeeCode(): Promise<string> {
  let n = (await employeeSelfRepo.count()) + 1;
  for (;;) {
    const code = `EMP${String(n).padStart(4, '0')}`;
    if (!(await employeeSelfRepo.count({ employeeCode: code }))) return code;
    n++;
  }
}

// ---------------------------------------------------------------- leave

export function leaveDays(fromDate: string, toDate: string, halfDay: boolean): number {
  if (toDate < fromDate) throw BadRequest('toDate must be on or after fromDate');
  if (halfDay) {
    if (fromDate !== toDate) throw BadRequest('A half-day leave must be a single day');
    return 0.5;
  }
  return daysInclusive(fromDate, toDate);
}

export async function leaveBalances(employeeId: number, year: number): Promise<LeaveBalanceDto[]> {
  await ensureDefaultLeaveTypes();
  const types = await leaveTypeRepo.findAll({ where: { active: true }, order: [['id', 'ASC']] });
  const apps = await leaveRepo.findAll({
    where: {
      employeeId,
      status: { [Op.in]: ['approved', 'pending'] },
      fromDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] },
    },
  });
  return types.map((t) => {
    const mine = apps.filter((a) => a.leaveTypeId === t.id);
    const used = mine.filter((a) => a.status === 'approved').reduce((s, a) => s + a.days, 0);
    const pending = mine.filter((a) => a.status === 'pending').reduce((s, a) => s + a.days, 0);
    return {
      leaveTypeId: t.id,
      code: t.code,
      name: t.name,
      quota: t.annualQuota,
      used,
      pending,
      available: t.annualQuota === null ? null : Math.max(0, t.annualQuota - used - pending),
    };
  });
}

export interface LeaveInput {
  leaveTypeId: number;
  fromDate: string;
  toDate: string;
  halfDay?: boolean;
  reason?: string | null;
}

export async function applyLeave(employee: Employee, input: LeaveInput): Promise<LeaveApplication> {
  const type = await leaveTypeRepo.findById(input.leaveTypeId);
  if (!type.active) throw BadRequest('This leave type is inactive');
  const days = leaveDays(input.fromDate, input.toDate, input.halfDay ?? false);
  const overlap = await leaveRepo.count({
    employeeId: employee.id,
    status: { [Op.in]: ['pending', 'approved'] },
    fromDate: { [Op.lte]: input.toDate },
    toDate: { [Op.gte]: input.fromDate },
  });
  if (overlap) throw Conflict('Overlaps an existing leave application', 'LEAVE_OVERLAP');
  if (type.annualQuota !== null) {
    const bal = (await leaveBalances(employee.id, Number(input.fromDate.slice(0, 4)))).find(
      (b) => b.leaveTypeId === type.id,
    );
    if (bal && bal.available !== null && bal.available < days)
      throw Conflict(`Insufficient ${type.name} balance (${bal.available} day(s) left)`, 'LEAVE_BALANCE');
  }
  return leaveRepo.create({
    employeeId: employee.id,
    leaveTypeId: type.id,
    fromDate: input.fromDate,
    toDate: input.toDate,
    halfDay: input.halfDay ?? false,
    days,
    reason: input.reason ?? null,
  });
}

/** Approve/reject. Approval marks the covered days as leave in staff attendance. */
export async function decideLeave(id: number, approve: boolean, note: string | null) {
  const leave = await leaveRepo.findById(id);
  if (leave.status !== 'pending') throw Conflict(`Leave is already ${leave.status}`, 'LEAVE_DECIDED');
  await employeeRepo.findById(leave.employeeId); // branch access check
  await getSequelize().transaction(async (transaction) => {
    await leave.update(
      {
        status: approve ? 'approved' : 'rejected',
        decidedBy: getContext().userId ?? null,
        decidedAt: new Date(),
        decisionNote: note,
      },
      { transaction },
    );
    if (approve) {
      const status: StaffAttendanceStatus = leave.halfDay ? 'half_day' : 'leave';
      for (const date of eachDate(leave.fromDate, leave.toDate)) {
        await upsertAttendanceRow(
          leave.employeeId,
          date,
          { status, source: 'leave', leaveApplicationId: leave.id, checkIn: null, checkOut: null },
          transaction,
        );
      }
    }
  });
  return leave;
}

/** Cancels a pending or approved leave and clears the attendance rows it created. */
export async function cancelLeave(leave: LeaveApplication) {
  if (!['pending', 'approved'].includes(leave.status)) throw Conflict(`Leave is already ${leave.status}`);
  await getSequelize().transaction(async (transaction) => {
    await StaffAttendance.destroy({
      where: { instituteId: leave.instituteId, leaveApplicationId: leave.id },
      transaction,
    });
    await leave.update({ status: 'cancelled' }, { transaction });
  });
}

// ---------------------------------------------------------------- attendance

async function upsertAttendanceRow(
  employeeId: number,
  date: string,
  values: Partial<
    Pick<StaffAttendance, 'status' | 'checkIn' | 'checkOut' | 'source' | 'leaveApplicationId' | 'remarks'>
  >,
  transaction?: Transaction,
) {
  const existing = await attendanceRepo.findOne({ where: { employeeId, date }, transaction });
  if (existing) return existing.update(values, { transaction });
  return attendanceRepo.create(
    {
      employeeId,
      date,
      status: values.status ?? 'present',
      checkIn: values.checkIn ?? null,
      checkOut: values.checkOut ?? null,
      source: values.source ?? 'manual',
      leaveApplicationId: values.leaveApplicationId ?? null,
      remarks: values.remarks ?? null,
    },
    { transaction },
  );
}

export interface ManualAttendanceEntry {
  employeeId: number;
  date: string;
  status: StaffAttendanceStatus;
  checkIn?: string | null;
  checkOut?: string | null;
  remarks?: string | null;
}

export async function saveManualAttendance(entries: ManualAttendanceEntry[]) {
  const ids = [...new Set(entries.map((e) => e.employeeId))];
  const visible = new Set(await visibleEmployeeIds({ id: { [Op.in]: ids } }));
  const missing = ids.filter((i) => !visible.has(i));
  if (missing.length) throw NotFound(`Employee ${missing.join(', ')}`);
  return getSequelize().transaction(async (transaction) => {
    const rows: StaffAttendance[] = [];
    for (const e of entries) {
      rows.push(
        await upsertAttendanceRow(
          e.employeeId,
          e.date,
          {
            status: e.status,
            checkIn: e.checkIn ?? null,
            checkOut: e.checkOut ?? null,
            remarks: e.remarks ?? null,
            source: 'manual',
            leaveApplicationId: null,
          },
          transaction,
        ),
      );
    }
    return rows;
  });
}

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const localHhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Ingests device punches through the biometric adapter (mock today). First punch of the day is
 * check-in, last is check-out; late is decided from the employee's shift and grace minutes.
 * Days already marked as leave or edited manually are left untouched.
 */
export async function ingestBiometric(payload: unknown) {
  const punches = await getBiometricAdapter().parsePush(payload);
  const enrolments = [...new Set(punches.map((p) => p.enrolmentId))];
  const employees = await employeeRepo.findAll({
    where: { biometricEnrolmentId: { [Op.in]: enrolments } },
    include: [{ model: Shift, as: 'shift' }],
  });
  const byEnrolment = new Map(employees.map((e) => [e.biometricEnrolmentId!, e]));
  const groups = new Map<string, { employee: Employee; date: string; times: string[] }>();
  const unmatched = new Set<string>();
  for (const p of punches) {
    const employee = byEnrolment.get(p.enrolmentId);
    if (!employee || Number.isNaN(p.punchedAt.getTime())) {
      unmatched.add(p.enrolmentId);
      continue;
    }
    const date = today(p.punchedAt);
    const key = `${employee.id}:${date}`;
    const g = groups.get(key) ?? { employee, date, times: [] };
    g.times.push(localHhmm(p.punchedAt));
    groups.set(key, g);
  }
  let updated = 0;
  let skipped = 0;
  for (const { employee, date, times } of groups.values()) {
    times.sort();
    const existing = await attendanceRepo.findOne({ where: { employeeId: employee.id, date } });
    if (existing && existing.source !== 'biometric') {
      skipped++;
      continue;
    }
    const shift = employee.shift;
    const late = shift ? minutes(times[0]) > minutes(shift.startTime) + shift.graceMinutes : false;
    await upsertAttendanceRow(employee.id, date, {
      status: late ? 'late' : 'present',
      checkIn: times[0],
      checkOut: times.length > 1 ? times[times.length - 1] : null,
      source: 'biometric',
      leaveApplicationId: null,
    });
    updated++;
  }
  return { punches: punches.length, updated, skipped, unmatched: [...unmatched] };
}

export interface AttendanceSummary {
  present: number;
  absent: number;
  late: number;
  leave: number;
  half_day: number;
  /** Loss-of-pay days: absences, half days and unpaid leave. */
  lopDays: number;
}

/** Per-employee attendance counts in a date range, including loss-of-pay days for payroll. */
export async function attendanceSummary(employeeIds: number[], from: string, to: string) {
  const rows = employeeIds.length
    ? await attendanceRepo.findAll({
        where: { employeeId: { [Op.in]: employeeIds }, date: { [Op.between]: [from, to] } },
        include: [
          {
            model: LeaveApplication,
            as: 'leaveApplication',
            include: [{ model: LeaveType, as: 'leaveType' }],
          },
        ],
      })
    : [];
  const out = new Map<number, AttendanceSummary>();
  for (const id of employeeIds)
    out.set(id, { present: 0, absent: 0, late: 0, leave: 0, half_day: 0, lopDays: 0 });
  for (const r of rows) {
    const s = out.get(r.employeeId)!;
    s[r.status] += 1;
    const paidLeave = r.leaveApplication ? (r.leaveApplication.leaveType?.paid ?? true) : null;
    if (r.status === 'absent') s.lopDays += 1;
    else if (r.status === 'half_day') s.lopDays += paidLeave ? 0 : 0.5;
    else if (r.status === 'leave' && paidLeave === false) s.lopDays += 1;
  }
  return out;
}

// ---------------------------------------------------------------- separation

export async function noticePeriodFor(employeeId: number): Promise<number> {
  const contract = await contractRepo.findOne({
    where: { employeeId, status: 'active' },
    order: [['startDate', 'DESC']],
  });
  return contract?.noticePeriodDays ?? 30;
}

export interface SeparationInput {
  type?: 'resignation' | 'termination' | 'retirement';
  submittedOn: string;
  lastWorkingDay?: string;
  noticePeriodDays?: number;
  reason?: string | null;
}

export async function submitSeparation(employee: Employee, input: SeparationInput) {
  if (await separationRepo.count({ employeeId: employee.id, status: { [Op.in]: ['submitted', 'accepted'] } }))
    throw Conflict('A separation is already in progress for this employee', 'SEPARATION_EXISTS');
  if (employee.status === 'exited') throw Conflict('Employee has already exited');
  const notice = input.noticePeriodDays ?? (await noticePeriodFor(employee.id));
  const lwd = input.lastWorkingDay ?? addDays(input.submittedOn, notice);
  if (lwd < input.submittedOn) throw BadRequest('lastWorkingDay cannot be before submittedOn');
  return separationRepo.create({
    employeeId: employee.id,
    type: input.type ?? 'resignation',
    submittedOn: input.submittedOn,
    noticePeriodDays: notice,
    lastWorkingDay: lwd,
    reason: input.reason ?? null,
  });
}

const SEPARATION_TRANSITIONS: Record<
  string,
  { from: string[]; employeeStatus?: 'on_notice' | 'active' | 'exited' }
> = {
  accepted: { from: ['submitted'], employeeStatus: 'on_notice' },
  rejected: { from: ['submitted'] },
  withdrawn: { from: ['submitted', 'accepted'], employeeStatus: 'active' },
  completed: { from: ['accepted'], employeeStatus: 'exited' },
};

export async function transitionSeparation(
  id: number,
  to: 'accepted' | 'rejected' | 'withdrawn' | 'completed',
  lastWorkingDay?: string,
) {
  const sep = await separationRepo.findById(id);
  const employee = await employeeRepo.findById(sep.employeeId);
  const rule = SEPARATION_TRANSITIONS[to];
  if (!rule.from.includes(sep.status)) throw Conflict(`Cannot move a ${sep.status} separation to ${to}`);
  await getSequelize().transaction(async (transaction) => {
    await sep.update(
      {
        status: to,
        decidedBy: getContext().userId ?? null,
        decidedAt: new Date(),
        ...(lastWorkingDay ? { lastWorkingDay } : {}),
      },
      { transaction },
    );
    if (rule.employeeStatus) {
      await employee.update(
        {
          status: rule.employeeStatus,
          dateOfExit:
            to === 'completed' ? sep.lastWorkingDay : to === 'withdrawn' ? null : employee.dateOfExit,
        },
        { transaction },
      );
    }
  });
  return sep;
}
