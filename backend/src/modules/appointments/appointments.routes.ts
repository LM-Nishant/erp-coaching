import { Router } from 'express';
import { z } from 'zod';
import { APPOINTMENT_MODES, APPOINTMENT_STATUSES, SLOT_KINDS, SLOT_MODES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import * as svc from './appointments.service';

const M = svc.MODULE;
const can = (action: Parameters<typeof requirePermission>[1]) => requirePermission(M, action);

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
const note = (max: number) => z.string().trim().max(max).nullable().optional();
const reason = z.string().trim().min(1).max(1000);
const id = z.coerce.number().int().positive();
const boolFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

const slotFields = {
  branchId: z.number().int().positive().optional(),
  teacherUserId: z.number().int().positive().optional(),
  kind: z.enum(SLOT_KINDS),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  date: date.nullable().optional(),
  startTime: time,
  endTime: time,
  slotMinutes: z.number().int().min(5).max(240).optional(),
  mode: z.enum(SLOT_MODES).optional(),
  location: note(200),
  effectiveFrom: date.nullable().optional(),
  effectiveTo: date.nullable().optional(),
  isActive: z.boolean().optional(),
};
const slotBody = z.object(slotFields).strict();
const slotPatch = z
  .object({
    ...slotFields,
    kind: slotFields.kind.optional(),
    startTime: time.optional(),
    endTime: time.optional(),
  })
  .omit({ teacherUserId: true })
  .strict();

const listQuery = paginationSchema.extend({
  status: z
    .union([z.enum(APPOINTMENT_STATUSES), z.array(z.enum(APPOINTMENT_STATUSES))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  from: date.optional(),
  to: date.optional(),
  studentId: id.optional(),
  teacherUserId: id.optional(),
  branchId: id.optional(),
  upcoming: boolFlag,
});

const reportQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  branchId: id.optional(),
  teacherUserId: id.optional(),
});

const requestBody = z
  .object({
    studentId: z.number().int().positive(),
    teacherUserId: z.number().int().positive(),
    date,
    startTime: time,
    mode: z.enum(APPOINTMENT_MODES),
    agenda: note(1000),
  })
  .strict();

const approveBody = z
  .object({
    note: note(1000),
    location: note(200),
    meetingUrl: z
      .string()
      .url()
      .max(500)
      .regex(/^https?:\/\//i, 'Use an http(s) meeting link')
      .nullable()
      .optional(),
  })
  .strict();
const reasonBody = z.object({ reason }).strict();
const rescheduleBody = z
  .object({
    date,
    startTime: time,
    endTime: time.optional(),
    mode: z.enum(APPOINTMENT_MODES).optional(),
    reason: note(1000),
  })
  .strict();
const notesBody = z.object({ sharedSummary: note(5000), privateNotes: note(5000) }).strict();
const completeBody = notesBody
  .extend({ outcome: z.enum(['completed', 'no_show']).default('completed') })
  .strict();

export function appointmentRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule(M));

  // Teacher availability (edit = own slots; configure = any teacher's).
  r.get('/slots', can('view'), async (req, res) => {
    const q = parse(z.object({ teacherUserId: id.optional(), includeInactive: boolFlag }), req.query);
    res.json(await svc.listSlots(q));
  });
  r.post('/slots', can('edit'), async (req, res) => {
    res.status(201).json(await svc.createSlot(parse(slotBody, req.body)));
  });
  r.patch('/slots/:id', can('edit'), async (req, res) => {
    const { id: slotId } = parse(idParam, req.params);
    res.json(await svc.updateSlot(slotId, parse(slotPatch, req.body)));
  });
  r.delete('/slots/:id', can('edit'), async (req, res) => {
    const { id: slotId } = parse(idParam, req.params);
    await svc.deleteSlot(slotId);
    res.status(204).end();
  });

  // Booking (parents).
  r.get('/children/:studentId/teachers', can('create'), async (req, res) => {
    const { studentId } = parse(z.object({ studentId: id }), req.params);
    res.json(await svc.teachersForChild(studentId));
  });
  r.get('/teachers/:teacherUserId/availability', can('view'), async (req, res) => {
    const { teacherUserId } = parse(z.object({ teacherUserId: id }), req.params);
    const q = parse(z.object({ studentId: id.optional(), from: date, to: date }), req.query);
    res.json(
      q.studentId
        ? await svc.availabilityForParent(teacherUserId, q.studentId, q.from, q.to)
        : await svc.availabilityForStaff(teacherUserId, q.from, q.to),
    );
  });
  r.post('/', can('create'), async (req, res) => {
    res.status(201).json(await svc.requestAppointment(parse(requestBody, req.body)));
  });

  // Lists, reports, detail.
  r.get('/', can('view'), async (req, res) => {
    res.json(await svc.listMine(parse(listQuery, req.query)));
  });
  r.get('/all', can('export'), async (req, res) => {
    res.json(await svc.listAll(parse(listQuery, req.query)));
  });
  r.get('/reports/summary', can('export'), async (req, res) => {
    res.json(await svc.reportSummary(parse(reportQuery, req.query)));
  });
  r.get('/reports/export.csv', can('export'), async (req, res) => {
    const csv = await svc.exportCsv(parse(reportQuery, req.query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="appointments-${Date.now()}.csv"`);
    res.send(csv);
  });
  r.get('/:id', can('view'), async (req, res) => {
    res.json(await svc.getDetail(parse(idParam, req.params).id));
  });

  // Lifecycle. Row-level checks (own meeting / linked child / manager) live in the service.
  r.post('/:id/approve', can('approve'), async (req, res) => {
    res.json(await svc.approve(parse(idParam, req.params).id, parse(approveBody, req.body ?? {})));
  });
  r.post('/:id/reject', can('approve'), async (req, res) => {
    res.json(await svc.reject(parse(idParam, req.params).id, parse(reasonBody, req.body).reason));
  });
  r.post('/:id/reschedule', can('view'), async (req, res) => {
    res.json(await svc.reschedule(parse(idParam, req.params).id, parse(rescheduleBody, req.body)));
  });
  r.post('/:id/cancel', can('view'), async (req, res) => {
    res.json(await svc.cancel(parse(idParam, req.params).id, parse(reasonBody, req.body).reason));
  });
  r.post('/:id/complete', can('approve'), async (req, res) => {
    res.json(await svc.complete(parse(idParam, req.params).id, parse(completeBody, req.body ?? {})));
  });
  r.patch('/:id/notes', can('approve'), async (req, res) => {
    res.json(await svc.updateNotes(parse(idParam, req.params).id, parse(notesBody, req.body)));
  });

  api.use('/appointments', r);
}
