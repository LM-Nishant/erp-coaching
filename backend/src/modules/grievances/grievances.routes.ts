import { Router } from 'express';
import { z } from 'zod';
import { GRIEVANCE_PRIORITIES, GRIEVANCE_STATUSES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { hasPermission } from '../../shared/context';
import { BadRequest } from '../../shared/errors';
import { uploadMiddleware } from '../files/files.routes';
import * as svc from './grievances.service';

const M = svc.MODULE;
const can = (action: Parameters<typeof requirePermission>[1]) => requirePermission(M, action);

const text = (max: number) => z.string().trim().min(1).max(max);
const boolFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
const dateParam = z.coerce.date().optional();

const categoryBody = z.object({
  name: text(100),
  description: z.string().trim().max(500).nullable().optional(),
  defaultAssigneeUserId: z.number().int().positive().nullable().optional(),
  slaHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .optional(),
  isActive: z.boolean().optional(),
});

const settingsBody = z.object({
  ticketPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/)
    .optional(),
  defaultSlaHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .optional(),
  escalationUserId: z.number().int().positive().nullable().optional(),
});

const createBody = z.object({
  categoryId: z.number().int().positive(),
  subject: text(200),
  description: text(5000),
  priority: z.enum(GRIEVANCE_PRIORITIES).optional(),
  branchId: z.number().int().positive().nullable().optional(),
  onBehalfOfUserId: z.number().int().positive().nullable().optional(),
});

const listQuery = paginationSchema.extend({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(GRIEVANCE_STATUSES)).optional()),
  priority: z.enum(GRIEVANCE_PRIORITIES).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  assignee: z.union([z.enum(['me', 'unassigned']), z.coerce.number().int().positive()]).optional(),
  overdue: boolFlag,
  from: dateParam,
  to: dateParam,
});

const reportQuery = z.object({
  from: dateParam,
  to: dateParam,
  categoryId: z.coerce.number().int().positive().optional(),
  branchId: z.coerce.number().int().positive().optional(),
});

export function grievanceRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule(M));

  // Categories & settings
  r.get('/categories', can('view'), async (req, res) => {
    const { all } = parse(z.object({ all: boolFlag }), req.query);
    res.json(await svc.listCategories(!!all && hasPermission(`${M}.configure`)));
  });
  r.post('/categories', can('configure'), async (req, res) => {
    res.status(201).json(await svc.createCategory(parse(categoryBody, req.body)));
  });
  r.patch('/categories/:id', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.updateCategory(id, parse(categoryBody.partial(), req.body)));
  });
  r.delete('/categories/:id', can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await svc.deleteCategory(id);
    res.status(204).end();
  });
  r.get('/settings', can('configure'), async (_req, res) => {
    res.json(svc.settingsDto(await svc.getOrInitSettings()));
  });
  r.put('/settings', can('configure'), async (req, res) => {
    res.json(await svc.updateSettings(parse(settingsBody, req.body)));
  });

  // People
  r.get('/assignees', can('edit'), async (_req, res) => {
    res.json(await svc.listAssignees());
  });
  r.get('/linked-students', can('create'), async (_req, res) => {
    res.json(await svc.linkedStudentsForCurrentUser());
  });

  // Reports
  r.get('/reports/summary', can('export'), async (req, res) => {
    res.json(await svc.reportSummary(parse(reportQuery, req.query)));
  });
  r.get('/reports/export.csv', can('export'), async (req, res) => {
    const csv = await svc.exportCsv(parse(reportQuery, req.query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="grievances-${Date.now()}.csv"`);
    res.send(csv);
  });

  // Tickets
  r.get('/mine', can('view'), async (req, res) => {
    res.json(await svc.listTickets(parse(listQuery, req.query), 'mine'));
  });
  /** Handlers get the branch queue; everyone else gets their own complaints. */
  r.get('/', can('view'), async (req, res) => {
    const mode = hasPermission(`${M}.edit`) ? 'queue' : 'mine';
    res.json(await svc.listTickets(parse(listQuery, req.query), mode));
  });
  r.post('/', can('create'), async (req, res) => {
    res.status(201).json(await svc.createTicket(parse(createBody, req.body)));
  });
  r.get('/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.getTicketDetail(id));
  });
  r.patch('/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        priority: z.enum(GRIEVANCE_PRIORITIES).optional(),
        categoryId: z.number().int().positive().optional(),
      }),
      req.body,
    );
    res.json(await svc.updateTicket(id, body));
  });
  r.post('/:id/assign', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        assigneeUserId: z.number().int().positive().nullable(),
        note: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    res.json(await svc.assignTicket(id, body));
  });
  r.post('/:id/status', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        status: z.enum(GRIEVANCE_STATUSES),
        note: z.string().trim().max(2000).optional(),
        resolutionNotes: z.string().trim().min(1).max(5000).optional(),
      }),
      req.body,
    );
    res.json(await svc.changeStatus(id, body));
  });
  r.post('/:id/comments', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ body: text(5000), internal: z.boolean().optional() }), req.body);
    res.status(201).json(await svc.addComment(id, body));
  });
  r.post('/:id/reopen', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.reopenTicket(id, parse(z.object({ reason: text(2000) }), req.body)));
  });
  r.post('/:id/confirm-closure', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        rating: z.number().int().min(1).max(5).optional(),
        feedback: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    res.json(await svc.confirmClosure(id, body));
  });
  r.post('/:id/attachments', can('view'), uploadMiddleware, async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (!req.file) throw BadRequest('Attach a file in the `file` field (blocked types are rejected)');
    const body = parse(
      z.object({ internal: boolFlag, commentId: z.coerce.number().int().positive().optional() }),
      req.body ?? {},
    );
    res.status(201).json(await svc.addAttachment(id, req.file, body));
  });
  r.get('/:id/attachments/:attachmentId/url', can('view'), async (req, res) => {
    const { id, attachmentId } = parse(
      idParam.extend({ attachmentId: z.coerce.number().int().positive() }),
      req.params,
    );
    res.json(await svc.attachmentUrl(id, attachmentId));
  });

  api.use('/grievances', r);
}
