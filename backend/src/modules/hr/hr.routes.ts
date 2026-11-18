import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { STAFF_ATTENDANCE_STATUSES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { BadRequest, Conflict, Forbidden } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { instituteToday } from '../../shared/timezone';
import { Employee, LeaveType } from './models';
import {
  applyLeave,
  assetRepo,
  assertBranchInInstitute,
  attendanceRepo,
  attendanceSummary,
  cancelLeave,
  currentEmployee,
  decideLeave,
  employeeRepo,
  ensureDefaultLeaveTypes,
  ingestBiometric,
  leaveBalances,
  leaveRepo,
  leaveTypeRepo,
  saveManualAttendance,
  separationRepo,
  shiftRepo,
  submitSeparation,
  transitionSeparation,
  visibleEmployeeIds,
} from './hr.service';
import { employeeRoutes } from './employees.routes';
import { hhmm, isoDate, monthBounds } from './dates';

const date = z.string().regex(isoDate, 'Use YYYY-MM-DD');
const time = z.string().regex(hhmm, 'Use HH:mm');
const optStr = (max: number) => z.string().trim().max(max).nullable().optional();
const monthQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

const shiftBody = z.object({
  branchId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(100),
  startTime: time,
  endTime: time,
  graceMinutes: z.number().int().min(0).max(240).optional(),
  weeklyOffs: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  active: z.boolean().optional(),
});

const leaveTypeBody = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{1,20}$/),
  name: z.string().trim().min(1).max(100),
  annualQuota: z.number().min(0).max(365).nullable().optional(),
  paid: z.boolean().optional(),
  encashable: z.boolean().optional(),
  active: z.boolean().optional(),
});

const leaveBody = z.object({
  leaveTypeId: z.number().int().positive(),
  fromDate: date,
  toDate: date,
  halfDay: z.boolean().optional(),
  reason: optStr(1000),
});

const assetBody = z.object({
  employeeId: z.number().int().positive(),
  name: z.string().trim().min(1).max(150),
  assetTag: optStr(60),
  issuedOn: date,
  returnedOn: date.nullable().optional(),
  valuePaise: z.number().int().min(0).optional(),
  status: z.enum(['issued', 'returned', 'lost']).optional(),
  notes: optStr(500),
});

const separationBody = z.object({
  employeeId: z.number().int().positive(),
  type: z.enum(['resignation', 'termination', 'retirement']).optional(),
  submittedOn: date,
  lastWorkingDay: date.optional(),
  noticePeriodDays: z.number().int().min(0).max(365).optional(),
  reason: optStr(2000),
});

const leaveInclude = [
  { model: Employee, as: 'employee', attributes: ['id', 'name', 'employeeCode', 'branchId'] },
  { model: LeaveType, as: 'leaveType', attributes: ['id', 'name', 'code', 'paid'] },
];

function setupRoutes(r: Router) {
  // ---- shifts
  r.get('/shifts', requirePermission('hr', 'view'), async (_req, res) => {
    res.json(await shiftRepo.findAll({ order: [['name', 'ASC']] }));
  });
  r.post('/shifts', requirePermission('hr', 'configure'), async (req, res) => {
    const body = parse(shiftBody, req.body);
    await assertBranchInInstitute(body.branchId);
    const shift = await shiftRepo.create({
      ...body,
      branchId: body.branchId ?? null,
      weeklyOffs: body.weeklyOffs ?? [0],
    });
    await audit({
      action: 'hr.shift.created',
      entityType: 'Shift',
      entityId: shift.id,
      metadata: { after: shift.toJSON() },
    });
    res.status(201).json(shift);
  });
  r.patch('/shifts/:id', requirePermission('hr', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(shiftBody.partial(), req.body);
    await assertBranchInInstitute(body.branchId);
    const before = (await shiftRepo.findById(id)).toJSON();
    const shift = await shiftRepo.update(id, body);
    await audit({
      action: 'hr.shift.updated',
      entityType: 'Shift',
      entityId: id,
      metadata: { before, after: shift.toJSON() },
    });
    res.json(shift);
  });
  r.delete('/shifts/:id', requirePermission('hr', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const shift = await shiftRepo.destroy(id);
    await audit({
      action: 'hr.shift.deleted',
      entityType: 'Shift',
      entityId: id,
      metadata: { before: shift.toJSON() },
    });
    res.status(204).end();
  });

  // ---- leave types
  r.get('/leave-types', requirePermission('hr', 'view'), async (_req, res) => {
    await ensureDefaultLeaveTypes();
    res.json(await leaveTypeRepo.findAll({ order: [['id', 'ASC']] }));
  });
  r.post('/leave-types', requirePermission('hr', 'configure'), async (req, res) => {
    const body = parse(leaveTypeBody, req.body);
    if (await leaveTypeRepo.count({ code: body.code })) throw Conflict('Leave type code already exists');
    const t = await leaveTypeRepo.create({ ...body, annualQuota: body.annualQuota ?? null });
    await audit({
      action: 'hr.leave_type.created',
      entityType: 'LeaveType',
      entityId: t.id,
      metadata: { after: t.toJSON() },
    });
    res.status(201).json(t);
  });
  r.patch('/leave-types/:id', requirePermission('hr', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(leaveTypeBody.partial(), req.body);
    const before = (await leaveTypeRepo.findById(id)).toJSON();
    const t = await leaveTypeRepo.update(id, body);
    await audit({
      action: 'hr.leave_type.updated',
      entityType: 'LeaveType',
      entityId: id,
      metadata: { before, after: t.toJSON() },
    });
    res.json(t);
  });
}

function attendanceRoutes(r: Router) {
  r.get('/attendance', requirePermission('hr', 'view'), async (req, res) => {
    const q = parse(
      z.object({ from: date, to: date, employeeId: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    const ids = await visibleEmployeeIds(q.employeeId ? { id: q.employeeId } : {});
    res.json(
      await attendanceRepo.findAll({
        where: { employeeId: { [Op.in]: ids }, date: { [Op.between]: [q.from, q.to] } },
        order: [
          ['date', 'ASC'],
          ['employeeId', 'ASC'],
        ],
      }),
    );
  });

  r.put('/attendance', requirePermission('hr', 'edit'), async (req, res) => {
    const { entries } = parse(
      z.object({
        entries: z
          .array(
            z.object({
              employeeId: z.number().int().positive(),
              date,
              status: z.enum(STAFF_ATTENDANCE_STATUSES),
              checkIn: time.nullable().optional(),
              checkOut: time.nullable().optional(),
              remarks: optStr(255),
            }),
          )
          .min(1)
          .max(1000),
      }),
      req.body,
    );
    const rows = await saveManualAttendance(entries);
    await audit({
      action: 'hr.attendance.saved',
      entityType: 'StaffAttendance',
      metadata: { count: rows.length, entries },
    });
    res.json(rows);
  });

  /** Biometric punches via the device adapter (mock). */
  r.post('/attendance/biometric', requirePermission('hr', 'edit'), async (req, res) => {
    const { punches } = parse(z.object({ punches: z.array(z.unknown()).min(1).max(5000) }), req.body);
    const result = await ingestBiometric(punches);
    await audit({
      action: 'hr.attendance.biometric_imported',
      entityType: 'StaffAttendance',
      metadata: result,
    });
    res.json(result);
  });

  r.get('/attendance/summary', requirePermission('hr', 'view'), async (req, res) => {
    const q = parse(monthQuery, req.query);
    const { start, end } = monthBounds(q.year, q.month);
    const employees = await employeeRepo.findAll({
      where: { dateOfJoining: { [Op.lte]: end } },
      attributes: ['id', 'name', 'employeeCode', 'branchId'],
      order: [['name', 'ASC']],
    });
    const summary = await attendanceSummary(
      employees.map((e) => e.id),
      start,
      end,
    );
    res.json(employees.map((e) => ({ employee: e, ...summary.get(e.id)! })));
  });
}

function leaveRoutes(r: Router) {
  r.get('/leaves', requirePermission('hr', 'view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
        employeeId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const ids = await visibleEmployeeIds(q.employeeId ? { id: q.employeeId } : {});
    const { rows, count } = await leaveRepo.findAndCountAll({
      where: { employeeId: { [Op.in]: ids }, ...(q.status ? { status: q.status } : {}) },
      include: leaveInclude,
      order: [['fromDate', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows, count, q));
  });

  /** HR applies leave on behalf of an employee. */
  r.post('/leaves', requirePermission('hr', 'create'), async (req, res) => {
    const body = parse(leaveBody.extend({ employeeId: z.number().int().positive() }), req.body);
    const emp = await employeeRepo.findById(body.employeeId);
    const leave = await applyLeave(emp, body);
    await audit({
      action: 'hr.leave.created',
      entityType: 'LeaveApplication',
      entityId: leave.id,
      metadata: { after: leave.toJSON() },
    });
    res.status(201).json(leave);
  });

  r.post('/leaves/:id/decision', requirePermission('hr', 'approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ approve: z.boolean(), note: optStr(500) }), req.body);
    const leave = await decideLeave(id, body.approve, body.note ?? null);
    await audit({
      action: body.approve ? 'hr.leave.approved' : 'hr.leave.rejected',
      entityType: 'LeaveApplication',
      entityId: id,
      metadata: { note: body.note ?? null },
    });
    res.json(leave);
  });

  r.post('/leaves/:id/cancel', requirePermission('hr', 'approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const leave = await leaveRepo.findById(id);
    await employeeRepo.findById(leave.employeeId);
    await cancelLeave(leave);
    await audit({ action: 'hr.leave.cancelled', entityType: 'LeaveApplication', entityId: id });
    res.json(leave);
  });

  r.get('/employees/:id/leave-balances', requirePermission('hr', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { year } = parse(
      z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
      req.query,
    );
    await employeeRepo.findById(id);
    res.json(await leaveBalances(id, year ?? Number((await instituteToday()).slice(0, 4))));
  });
}

function lifecycleRoutes(r: Router) {
  // ---- assets
  r.get('/assets', requirePermission('hr', 'view'), async (req, res) => {
    const q = parse(
      z.object({
        employeeId: z.coerce.number().int().positive().optional(),
        status: z.enum(['issued', 'returned', 'lost']).optional(),
      }),
      req.query,
    );
    const ids = await visibleEmployeeIds(q.employeeId ? { id: q.employeeId } : {});
    res.json(
      await assetRepo.findAll({
        where: { employeeId: { [Op.in]: ids }, ...(q.status ? { status: q.status } : {}) },
        order: [['issuedOn', 'DESC']],
      }),
    );
  });
  r.post('/assets', requirePermission('hr', 'edit'), async (req, res) => {
    const body = parse(assetBody, req.body);
    await employeeRepo.findById(body.employeeId);
    const asset = await assetRepo.create({
      ...body,
      assetTag: body.assetTag ?? null,
      returnedOn: body.returnedOn ?? null,
      notes: body.notes ?? null,
    });
    await audit({
      action: 'hr.asset.issued',
      entityType: 'EmployeeAsset',
      entityId: asset.id,
      metadata: { after: asset.toJSON() },
    });
    res.status(201).json(asset);
  });
  r.patch('/assets/:id', requirePermission('hr', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(assetBody.omit({ employeeId: true }).partial(), req.body);
    const asset = await assetRepo.findById(id);
    await employeeRepo.findById(asset.employeeId);
    const before = asset.toJSON();
    if (body.status === 'returned' && !body.returnedOn && !asset.returnedOn)
      body.returnedOn = await instituteToday();
    await asset.update(body);
    await audit({
      action: 'hr.asset.updated',
      entityType: 'EmployeeAsset',
      entityId: id,
      metadata: { before, after: asset.toJSON() },
    });
    res.json(asset);
  });
  r.delete('/assets/:id', requirePermission('hr', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const asset = await assetRepo.findById(id);
    await employeeRepo.findById(asset.employeeId);
    await asset.destroy();
    await audit({
      action: 'hr.asset.deleted',
      entityType: 'EmployeeAsset',
      entityId: id,
      metadata: { before: asset.toJSON() },
    });
    res.status(204).end();
  });

  // ---- resignation / separation and notice period
  r.get('/separations', requirePermission('hr', 'view'), async (req, res) => {
    const q = parse(
      z.object({
        status: z.enum(['submitted', 'accepted', 'rejected', 'withdrawn', 'completed']).optional(),
        employeeId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const ids = await visibleEmployeeIds(q.employeeId ? { id: q.employeeId } : {});
    res.json(
      await separationRepo.findAll({
        where: { employeeId: { [Op.in]: ids }, ...(q.status ? { status: q.status } : {}) },
        include: [{ model: Employee, as: 'employee', attributes: ['id', 'name', 'employeeCode', 'status'] }],
        order: [['submittedOn', 'DESC']],
      }),
    );
  });
  r.post('/separations', requirePermission('hr', 'create'), async (req, res) => {
    const body = parse(separationBody, req.body);
    const emp = await employeeRepo.findById(body.employeeId);
    const sep = await submitSeparation(emp, body);
    await audit({
      action: 'hr.separation.created',
      entityType: 'EmployeeSeparation',
      entityId: sep.id,
      metadata: { after: sep.toJSON() },
    });
    res.status(201).json(sep);
  });
  r.post('/separations/:id/:transition', requirePermission('hr', 'approve'), async (req, res) => {
    const { id, transition } = parse(
      idParam.extend({ transition: z.enum(['accept', 'reject', 'withdraw', 'complete']) }),
      req.params,
    );
    const { lastWorkingDay } = parse(z.object({ lastWorkingDay: date.optional() }), req.body ?? {});
    const to = (
      { accept: 'accepted', reject: 'rejected', withdraw: 'withdrawn', complete: 'completed' } as const
    )[transition];
    const sep = await transitionSeparation(id, to, lastWorkingDay);
    await audit({
      action: `hr.separation.${to}`,
      entityType: 'EmployeeSeparation',
      entityId: id,
      metadata: { lastWorkingDay },
    });
    res.json(sep);
  });
}

/** Employee self-service: own profile, attendance, leave and resignation. */
function selfServiceRoutes(r: Router) {
  r.get('/me', requirePermission('hr-self-service', 'view'), async (_req, res) => {
    res.json(await currentEmployee());
  });
  r.get('/me/leave-balances', requirePermission('hr-self-service', 'view'), async (req, res) => {
    const { year } = parse(
      z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
      req.query,
    );
    const emp = await currentEmployee();
    res.json(await leaveBalances(emp.id, year ?? Number((await instituteToday()).slice(0, 4))));
  });
  r.get('/me/leave-types', requirePermission('hr-self-service', 'view'), async (_req, res) => {
    await ensureDefaultLeaveTypes();
    res.json(await leaveTypeRepo.findAll({ where: { active: true }, order: [['id', 'ASC']] }));
  });
  r.get('/me/leaves', requirePermission('hr-self-service', 'view'), async (_req, res) => {
    const emp = await currentEmployee();
    res.json(
      await leaveRepo.findAll({
        where: { employeeId: emp.id },
        include: leaveInclude,
        order: [['fromDate', 'DESC']],
      }),
    );
  });
  r.post('/me/leaves', requirePermission('hr-self-service', 'create'), async (req, res) => {
    const body = parse(leaveBody, req.body);
    const emp = await currentEmployee();
    const leave = await applyLeave(emp, body);
    await audit({
      action: 'hr.leave.created',
      entityType: 'LeaveApplication',
      entityId: leave.id,
      metadata: { after: leave.toJSON(), selfService: true },
    });
    res.status(201).json(leave);
  });
  r.post('/me/leaves/:id/cancel', requirePermission('hr-self-service', 'create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const emp = await currentEmployee();
    const leave = await leaveRepo.findById(id, { where: { employeeId: emp.id } });
    if (leave.status !== 'pending') throw Forbidden('Only pending leave can be withdrawn; contact HR');
    await cancelLeave(leave);
    await audit({
      action: 'hr.leave.cancelled',
      entityType: 'LeaveApplication',
      entityId: id,
      metadata: { selfService: true },
    });
    res.json(leave);
  });
  r.get('/me/attendance', requirePermission('hr-self-service', 'view'), async (req, res) => {
    const q = parse(monthQuery, req.query);
    const emp = await currentEmployee();
    const { start, end } = monthBounds(q.year, q.month);
    res.json(
      await attendanceRepo.findAll({
        where: { employeeId: emp.id, date: { [Op.between]: [start, end] } },
        order: [['date', 'ASC']],
      }),
    );
  });
  r.post('/me/resignation', requirePermission('hr-self-service', 'create'), async (req, res) => {
    const body = parse(z.object({ lastWorkingDay: date.optional(), reason: optStr(2000) }), req.body);
    const emp = await currentEmployee();
    const day = await instituteToday();
    if (body.lastWorkingDay && body.lastWorkingDay < day) throw BadRequest('lastWorkingDay is in the past');
    const sep = await submitSeparation(emp, { ...body, type: 'resignation', submittedOn: day });
    await audit({
      action: 'hr.separation.created',
      entityType: 'EmployeeSeparation',
      entityId: sep.id,
      metadata: { selfService: true },
    });
    res.status(201).json(sep);
  });
}

export function hrRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule('hr'));
  selfServiceRoutes(r);
  employeeRoutes(r);
  setupRoutes(r);
  attendanceRoutes(r);
  leaveRoutes(r);
  lifecycleRoutes(r);
  api.use('/hr', r);
}
