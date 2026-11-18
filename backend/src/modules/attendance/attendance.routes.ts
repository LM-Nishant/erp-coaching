import { Router, type Response } from 'express';
import { z } from 'zod';
import { ATTENDANCE_METHODS, ATTENDANCE_STATUSES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { deviceRateLimit } from '../../shared/middleware/security';
import { getContext, hasPermission, requireTenantContext, runWithContext } from '../../shared/context';
import { AppError, BadRequest, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { getLinkedStudentUsers } from '../guardians/guardian-access';
import { type Cell, toCsv, toSpreadsheetXml } from './export';
import { getAttendanceSettings, updateAttendanceSettings } from './settings';
import {
  assertCanManageSession,
  checkIn,
  checkInOptions,
  closeSession,
  countsFor,
  dayOverview,
  getRoster,
  getSessionScoped,
  issueQrToken,
  markRoster,
  recordRepo,
  resolveSession,
  toSessionDto,
} from './sessions.service';
import {
  cancelCorrection,
  cancelLeave,
  createCorrection,
  createLeave,
  decideCorrection,
  decideLeave,
  leaveRepo,
  listCorrections,
  listMyCorrections,
  listMyLeaves,
  resolveSubject,
  toCorrectionDto,
  toLeaveDto,
} from './requests.service';
import { groupReport, studentReport, studentSummary, type ReportFilter } from './reports.service';
import {
  authenticateDevice,
  createDevice,
  deleteDevice,
  deleteEnrolment,
  deviceRepo,
  ingestPunches,
  listDeviceEvents,
  listEnrolments,
  parseDevicePayload,
  rotateDeviceKey,
  toDeviceDto,
  updateDevice,
  upsertEnrolment,
} from './devices.service';
import { isoDate, localDate } from './time';
import { getInstituteTimezone } from '../../shared/timezone';
import { User } from '../users/user.model';

const pid = (req: { params: unknown }) => parse(idParam, req.params).id;
const date = z.string().regex(isoDate, 'Use YYYY-MM-DD');
const status = z.enum(ATTENDANCE_STATUSES);
const id = z.coerce.number().int().positive();
const note = z.string().trim().max(500).nullable().optional();
const format = z.enum(['json', 'csv', 'xls']).default('json');

const settingsBody = z
  .object({
    mode: z.enum(['class', 'daily']),
    methods: z.array(z.enum(ATTENDANCE_METHODS)).max(ATTENDANCE_METHODS.length),
    lateAfterMinutes: z.number().int().min(0).max(240),
    checkInOpensMinutes: z.number().int().min(0).max(240),
    checkInClosesMinutes: z.number().int().min(0).max(600),
    qrRotateSeconds: z.number().int().min(10).max(600),
    requireGeofence: z.boolean(),
    geofences: z.record(
      z.string().regex(/^\d+$/),
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusM: z.number().int().min(20).max(10000),
      }),
    ),
    correctionApproval: z.enum(['auto', 'teacher', 'admin']),
    parentCorrections: z.boolean(),
    correctionWindowDays: z.number().int().min(0).max(365),
    absentAlerts: z.boolean(),
    excludeLeaveFromTotal: z.boolean(),
    halfDayWeight: z.number().min(0).max(1),
    minPercentage: z.number().min(0).max(100),
    liveMinPercent: z.number().int().min(0).max(100),
  })
  .partial();

const sessionBody = z
  .object({ classSessionId: id.optional(), batchId: id.optional(), date: date.optional() })
  .refine((b) => b.classSessionId || b.batchId, 'classSessionId or batchId is required');

const recordsBody = z.object({
  records: z
    .array(
      z.object({
        studentUserId: z.number().int().positive(),
        status,
        remarks: z.string().trim().max(255).nullable().optional(),
      }),
    )
    .min(1)
    .max(1000),
});

const checkInBody = z.object({
  method: z.enum(['qr', 'mobile']),
  token: z.string().max(200).optional(),
  classSessionId: id.optional(),
  batchId: id.optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

const correctionBody = z.object({
  attendanceSessionId: z.number().int().positive(),
  studentUserId: z.number().int().positive().optional(),
  requestedStatus: status,
  reason: z.string().trim().min(3).max(1000),
});

const leaveBody = z.object({
  studentUserId: z.number().int().positive().optional(),
  fromDate: date,
  toDate: date,
  reason: z.string().trim().min(3).max(1000),
});

const decideBody = z.object({ approve: z.boolean(), note });
const requestList = paginationSchema.extend({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
});

const reportQuery = z
  .object({
    from: date,
    to: date,
    batchId: id.optional(),
    branchId: id.optional(),
    format,
  })
  .refine((q) => q.from <= q.to, 'from must be on or before to');

const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

const deviceBody = z.object({
  name: z.string().trim().min(1).max(100),
  serial: z.string().trim().min(1).max(100),
  branchId: z.number().int().positive().nullable().optional(),
});
const devicePatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  active: z.boolean().optional(),
  branchId: z.number().int().positive().nullable().optional(),
});
const enrolmentBody = z.object({
  studentUserId: z.number().int().positive(),
  enrolmentId: z.string().trim().min(1).max(50),
});
const eventList = paginationSchema.extend({
  status: z.enum(['applied', 'duplicate', 'unmatched', 'no_session', 'ignored']).optional(),
});

function send(
  res: Response,
  fmt: 'json' | 'csv' | 'xls',
  name: string,
  headers: string[],
  rows: Cell[][],
  json: unknown,
) {
  if (fmt === 'json') return res.json(json);
  const file = name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  if (fmt === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.csv"`);
    return res.send(toCsv(headers, rows));
  }
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}.xls"`);
  return res.send(toSpreadsheetXml(name, headers, rows));
}

const TOTAL_HEADERS = ['Present', 'Late', 'Half day', 'Absent', 'Leave', 'Counted sessions', 'Attendance %'];
const totalCells = (t: {
  present: number;
  late: number;
  half_day: number;
  absent: number;
  leave: number;
  total: number;
  percentage: number | null;
}): Cell[] => [t.present, t.late, t.half_day, t.absent, t.leave, t.total, t.percentage];

/* ------------------------------------------------------------------ staff */

function settingsRoutes(r: Router) {
  r.get('/settings', requirePermission('attendance', 'view'), async (_req, res) => {
    res.json(await getAttendanceSettings());
  });
  r.put('/settings', requirePermission('attendance', 'configure'), async (req, res) => {
    const patch = parse(settingsBody, req.body);
    const { before, after } = await updateAttendanceSettings(patch);
    await audit({
      action: 'attendance.settings.updated',
      entityType: 'AttendanceSettings',
      metadata: { before, after },
    });
    res.json(after);
  });
}

function sessionRoutes(r: Router) {
  r.get('/day', requirePermission('attendance', 'view'), async (req, res) => {
    const q = parse(z.object({ date: date.optional(), batchId: id.optional() }), req.query);
    res.json(await dayOverview(q.date ?? localDate(await getInstituteTimezone()), q.batchId));
  });

  /** Opens (or returns) the attendance session for a class or batch-day and its roster. */
  r.post('/sessions', requirePermission('attendance', 'create'), async (req, res) => {
    const body = parse(sessionBody, req.body);
    const session = await resolveSession(body, { scoped: true });
    await assertCanManageSession(session);
    const full = await getSessionScoped(session.id);
    res.status(201).json({ session: toSessionDto(full), roster: await getRoster(full) });
  });

  r.get('/sessions/:id', requirePermission('attendance', 'view'), async (req, res) => {
    const session = await getSessionScoped(pid(req));
    const counts = (await countsFor([session.id])).get(session.id) ?? {};
    res.json({ session: toSessionDto(session, { counts }), roster: await getRoster(session) });
  });

  r.put('/sessions/:id/records', requirePermission('attendance', 'create'), async (req, res) => {
    const session = await getSessionScoped(pid(req));
    const { records } = parse(recordsBody, req.body);
    const saved = await markRoster(session, records);
    await audit({
      action: 'attendance.records.marked',
      entityType: 'AttendanceSession',
      entityId: session.id,
      metadata: { after: records, closed: session.status === 'closed' },
    });
    res.json({ saved, session: toSessionDto(session), roster: await getRoster(session) });
  });

  r.post('/sessions/:id/close', requirePermission('attendance', 'create'), async (req, res) => {
    const session = await getSessionScoped(pid(req));
    await assertCanManageSession(session);
    const wasOpen = session.status === 'open';
    await closeSession(session, requireTenantContext().userId);
    if (wasOpen)
      await audit({
        action: 'attendance.session.closed',
        entityType: 'AttendanceSession',
        entityId: session.id,
      });
    res.json({ session: toSessionDto(session), roster: await getRoster(session) });
  });

  r.post('/sessions/:id/reopen', requirePermission('attendance', 'edit'), async (req, res) => {
    const session = await getSessionScoped(pid(req));
    if (session.status === 'closed') {
      await session.update({ status: 'open', closedAt: null, closedByUserId: null });
      await audit({
        action: 'attendance.session.reopened',
        entityType: 'AttendanceSession',
        entityId: session.id,
      });
    }
    res.json({ session: toSessionDto(session) });
  });

  r.get('/sessions/:id/qr', requirePermission('attendance', 'create'), async (req, res) => {
    res.json(await issueQrToken(await getSessionScoped(pid(req))));
  });
}

function requestStaffRoutes(r: Router) {
  r.get('/corrections', requirePermission('attendance', 'view'), async (req, res) => {
    const q = parse(requestList, req.query);
    const { rows, count } = await listCorrections({ status: q.status, page: q.page, pageSize: q.pageSize });
    res.json(
      paginated(
        rows.map((c) => toCorrectionDto(c)),
        count,
        q,
      ),
    );
  });
  r.post('/corrections/:id/decide', requirePermission('attendance', 'view'), async (req, res) => {
    const body = parse(decideBody, req.body);
    res.json(await decideCorrection(pid(req), body.approve, body.note ?? null));
  });

  r.get('/leaves', requirePermission('attendance', 'view'), async (req, res) => {
    const q = parse(requestList, req.query);
    const { rows, count } = await leaveRepo.findAndCountAll({
      where: q.status ? { status: q.status } : {},
      include: [{ model: User, as: 'student', attributes: ['id', 'name'] }],
      order: [['createdAt', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(
      paginated(
        rows.map((l) => toLeaveDto(l)),
        count,
        q,
      ),
    );
  });
  r.post('/leaves/:id/decide', requirePermission('attendance', 'approve'), async (req, res) => {
    const body = parse(decideBody, req.body);
    res.json(await decideLeave(pid(req), body.approve, body.note ?? null));
  });
}

function reportRoutes(r: Router) {
  const filterOf = (q: z.infer<typeof reportQuery>): ReportFilter => ({
    from: q.from,
    to: q.to,
    batchId: q.batchId,
    branchId: q.branchId,
  });
  const assertExport = async (fmt: string, name: string, q: object) => {
    if (fmt === 'json') return;
    if (!hasPermission('attendance.export')) throw Forbidden('You cannot export attendance', 'FORBIDDEN');
    await audit({
      action: 'attendance.report.exported',
      entityType: 'AttendanceReport',
      metadata: { report: name, ...q },
    });
  };

  r.get('/reports/students', requirePermission('attendance', 'view'), async (req, res) => {
    const q = parse(reportQuery, req.query);
    const rows = await studentReport(filterOf(q));
    await assertExport(q.format, 'students', q);
    send(
      res,
      q.format,
      `attendance-students-${q.from}-${q.to}`,
      ['Student', ...TOTAL_HEADERS, 'Below threshold'],
      rows.map((x) => [x.name, ...totalCells(x), x.belowThreshold ? 'Yes' : 'No']),
      rows,
    );
  });

  for (const by of ['batch', 'branch'] as const)
    r.get(`/reports/${by}es`, requirePermission('attendance', 'view'), async (req, res) => {
      const q = parse(reportQuery, req.query);
      const rows = await groupReport(by, filterOf(q));
      await assertExport(q.format, `${by}es`, q);
      send(
        res,
        q.format,
        `attendance-${by}es-${q.from}-${q.to}`,
        [by === 'batch' ? 'Batch' : 'Branch', 'Students', ...TOTAL_HEADERS],
        rows.map((x) => [x.name, x.students, ...totalCells(x)]),
        rows,
      );
    });

  r.get('/reports/students/:id', requirePermission('attendance', 'view'), async (req, res) => {
    const q = parse(yearQuery, req.query);
    const studentUserId = pid(req);
    // Only students with attendance in the caller's branches.
    if (!(await recordRepo.count({ studentUserId }))) throw NotFound('Student');
    res.json(await studentSummary(studentUserId, q.year ?? new Date().getFullYear()));
  });
}

function deviceRoutes(r: Router) {
  r.get('/devices', requirePermission('attendance', 'configure'), async (_req, res) => {
    res.json((await deviceRepo.findAll({ order: [['name', 'ASC']] })).map((d) => toDeviceDto(d)));
  });
  r.post('/devices', requirePermission('attendance', 'configure'), async (req, res) => {
    res.status(201).json(await createDevice(parse(deviceBody, req.body)));
  });
  r.patch('/devices/:id', requirePermission('attendance', 'configure'), async (req, res) => {
    res.json(await updateDevice(pid(req), parse(devicePatch, req.body)));
  });
  r.post('/devices/:id/rotate-key', requirePermission('attendance', 'configure'), async (req, res) => {
    res.json(await rotateDeviceKey(pid(req)));
  });
  r.delete('/devices/:id', requirePermission('attendance', 'configure'), async (req, res) => {
    await deleteDevice(pid(req));
    res.status(204).end();
  });
  /** Manual upload of a device export (same payload as the device push). */
  r.post('/devices/:id/events', requirePermission('attendance', 'edit'), async (req, res) => {
    const device = await deviceRepo.findById(pid(req));
    deviceRepo.assertRowWritable(device);
    const punches = await parseDevicePayload(req.body?.punches ?? req.body);
    if (punches.length > 1000) throw BadRequest('At most 1000 punches per upload');
    const result = await ingestPunches(device, punches);
    await audit({
      action: 'attendance.device.events-imported',
      entityType: 'AttendanceDevice',
      entityId: device.id,
      metadata: { ...result },
    });
    res.json(result);
  });
  r.get('/device-events', requirePermission('attendance', 'configure'), async (req, res) => {
    const q = parse(eventList, req.query);
    const { rows, count } = await listDeviceEvents({ status: q.status, page: q.page, pageSize: q.pageSize });
    res.json(paginated(rows, count, q));
  });

  r.get('/enrolments', requirePermission('attendance', 'configure'), async (_req, res) => {
    res.json(await listEnrolments());
  });
  r.put('/enrolments', requirePermission('attendance', 'configure'), async (req, res) => {
    const body = parse(enrolmentBody, req.body);
    res.json(await upsertEnrolment(body.studentUserId, body.enrolmentId));
  });
  r.delete('/enrolments/:id', requirePermission('attendance', 'configure'), async (req, res) => {
    await deleteEnrolment(pid(req));
    res.status(204).end();
  });
}

/* ------------------------------------------------------------ self service */

function selfRoutes(r: Router) {
  r.get('/me/check-in-options', requirePermission('attendance-self', 'view'), async (_req, res) => {
    res.json(await checkInOptions());
  });
  r.post('/check-in', requirePermission('attendance-self', 'create'), async (req, res) => {
    res.json(await checkIn(parse(checkInBody, req.body)));
  });
  r.get('/me/summary', requirePermission('attendance-self', 'view'), async (req, res) => {
    const q = parse(yearQuery, req.query);
    res.json(await studentSummary(requireTenantContext().userId!, q.year ?? new Date().getFullYear()));
  });
  r.get('/me/children', requirePermission('attendance-self', 'view'), async (_req, res) => {
    const children = await getLinkedStudentUsers(requireTenantContext().userId!);
    res.json(children.map((c) => ({ studentUserId: c.id, name: c.name })));
  });
  r.get('/me/children/:id/summary', requirePermission('attendance-self', 'view'), async (req, res) => {
    const q = parse(yearQuery, req.query);
    const subject = await resolveSubject(pid(req));
    res.json(await studentSummary(subject.studentUserId, q.year ?? new Date().getFullYear()));
  });

  r.get('/me/corrections', requirePermission('attendance-self', 'view'), async (_req, res) => {
    res.json((await listMyCorrections()).map((c) => toCorrectionDto(c)));
  });
  r.post('/me/corrections', requirePermission('attendance-self', 'create'), async (req, res) => {
    res.status(201).json(await createCorrection(parse(correctionBody, req.body)));
  });
  r.post('/me/corrections/:id/cancel', requirePermission('attendance-self', 'create'), async (req, res) => {
    res.json(await cancelCorrection(pid(req)));
  });

  r.get('/me/leaves', requirePermission('attendance-self', 'view'), async (_req, res) => {
    res.json((await listMyLeaves()).map((l) => toLeaveDto(l)));
  });
  r.post('/me/leaves', requirePermission('attendance-self', 'create'), async (req, res) => {
    res.status(201).json(await createLeave(parse(leaveBody, req.body)));
  });
  r.post('/me/leaves/:id/cancel', requirePermission('attendance-self', 'create'), async (req, res) => {
    res.json(await cancelLeave(pid(req)));
  });
}

/* ----------------------------------------------------------------- public */

function publicRoutes(pub: Router) {
  /**
   * Biometric device push. The device authenticates with its serial and API key (headers); the
   * institute comes from the registered device, never from the request body.
   */
  pub.post('/device-events', deviceRateLimit, async (req, res) => {
    const device = await authenticateDevice(
      String(req.get('x-device-serial') ?? ''),
      String(req.get('x-device-key') ?? ''),
    );
    if (!device) throw new AppError(401, 'DEVICE_UNAUTHORIZED', 'Unknown device or invalid key');
    if (!(await isModuleEnabled(device.instituteId, 'attendance')))
      throw Forbidden('Attendance is not enabled for this institute', 'MODULE_DISABLED');
    const result = await runWithContext(
      { ...getContext(), system: true, instituteId: device.instituteId, allowedBranchIds: null },
      async () => {
        const punches = await parseDevicePayload(req.body?.punches ?? req.body);
        if (punches.length > 1000) throw BadRequest('At most 1000 punches per push');
        return ingestPunches(device, punches);
      },
    );
    res.json(result);
  });
}

export function attendanceRoutes(api: Router) {
  const pub = Router();
  publicRoutes(pub);
  api.use('/attendance/public', pub);

  const r = Router();
  r.use(authenticate, requireModule('attendance'));
  settingsRoutes(r);
  sessionRoutes(r);
  requestStaffRoutes(r);
  reportRoutes(r);
  deviceRoutes(r);
  selfRoutes(r);
  api.use('/attendance', r);
}
