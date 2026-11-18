import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import { Forbidden, NotFound } from '../../shared/errors';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin, requireTenant } from '../../shared/middleware/authorize';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { parse } from '../../shared/utilities/validation';
import { Institute } from '../institutes/institute.model';
import {
  approveDeletion,
  cancelDeletion,
  cancelOwnDeletionRequest,
  DEFAULT_GRACE_DAYS,
  latestDeletionRequest,
  listDeletionRequests,
  rejectDeletion,
  requestDeletion,
  retryDeletion,
} from './deletion.service';
import {
  createExportLink,
  deleteExport,
  listExports,
  openExportDownload,
  requestExport,
} from './export.service';

const exportBody = z.object({ includeMedia: z.boolean().default(true) });
const deletionBody = z.object({
  confirm: z.string().trim().min(1).max(100),
  reason: z.string().trim().max(1000).nullish(),
});
const noteBody = z.object({ note: z.string().trim().max(1000).nullish() });
const approveBody = noteBody.extend({
  graceDays: z.number().int().min(0).max(365).default(DEFAULT_GRACE_DAYS),
});
const exportParams = z.object({
  id: z.coerce.number().int().positive(),
  exportId: z.coerce.number().int().positive(),
});
const DELETION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'purging',
  'completed',
  'failed',
] as const;

/** Whole-institute data is only for administrators who are not limited to some branches. */
const requireInstituteWide: RequestHandler = (req, _res, next) => {
  if (Array.isArray(req.ctx.allowedBranchIds))
    throw Forbidden('Only institute-wide administrators can do this', 'INSTITUTE_WIDE_ACCESS_REQUIRED');
  next();
};

function tenantRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireTenant, requireInstituteWide);

  r.get('/exports', requirePermission('tenant-data', 'view'), async (_req, res) => {
    res.json(await listExports(requireTenantContext().instituteId));
  });

  r.post('/exports', requirePermission('tenant-data', 'export'), async (req, res) => {
    const body = parse(exportBody, req.body ?? {});
    res.status(201).json(await requestExport(requireTenantContext().instituteId, body));
  });

  r.post('/exports/:id/link', requirePermission('tenant-data', 'export'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await createExportLink(requireTenantContext().instituteId, id));
  });

  r.delete('/exports/:id', requirePermission('tenant-data', 'export'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await deleteExport(requireTenantContext().instituteId, id);
    res.status(204).end();
  });

  r.get('/deletion-request', requirePermission('tenant-data', 'view'), async (_req, res) => {
    res.json({ request: await latestDeletionRequest(requireTenantContext().instituteId) });
  });

  r.post('/deletion-request', requirePermission('tenant-data', 'delete'), async (req, res) => {
    const body = parse(deletionBody, req.body);
    res.status(201).json(await requestDeletion(requireTenantContext().instituteId, body));
  });

  r.post('/deletion-request/cancel', requirePermission('tenant-data', 'delete'), async (_req, res) => {
    res.json(await cancelOwnDeletionRequest(requireTenantContext().instituteId));
  });

  api.use('/tenant-data', r);
}

function adminRoutes(api: Router) {
  const a = Router();
  a.use(authenticate, requireSuperAdmin);

  const institute = async (id: number) => {
    const row = await Institute.findByPk(id, { attributes: ['id'] });
    if (!row) throw NotFound('Institute');
    return row.id;
  };

  a.get('/deletion-requests', async (req, res) => {
    const q = parse(paginationSchema.extend({ status: z.enum(DELETION_STATUSES).optional() }), req.query);
    res.json(await listDeletionRequests(q));
  });

  a.post('/deletion-requests/:id/approve', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await approveDeletion(id, parse(approveBody, req.body ?? {})));
  });

  a.post('/deletion-requests/:id/reject', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await rejectDeletion(id, parse(noteBody, req.body ?? {})));
  });

  a.post('/deletion-requests/:id/cancel', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await cancelDeletion(id, parse(noteBody, req.body ?? {})));
  });

  a.post('/deletion-requests/:id/retry', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await retryDeletion(id));
  });

  a.get('/institutes/:id/deletion-request', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ request: await latestDeletionRequest(await institute(id)) });
  });

  // Raised by support on the institute's behalf (e.g. a written request); still needs approval.
  a.post('/institutes/:id/deletion-request', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.status(201).json(await requestDeletion(await institute(id), parse(deletionBody, req.body)));
  });

  a.get('/institutes/:id/exports', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await listExports(await institute(id)));
  });

  a.post('/institutes/:id/exports', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.status(201).json(await requestExport(await institute(id), parse(exportBody, req.body ?? {})));
  });

  a.post('/institutes/:id/exports/:exportId/link', async (req, res) => {
    const p = parse(exportParams, req.params);
    res.json(await createExportLink(await institute(p.id), p.exportId));
  });

  a.delete('/institutes/:id/exports/:exportId', async (req, res) => {
    const p = parse(exportParams, req.params);
    await deleteExport(await institute(p.id), p.exportId);
    res.status(204).end();
  });

  api.use('/admin/tenant-data', a);
}

function publicRoutes(api: Router) {
  // The short-lived signed token is the credential (links are created by an authorised user).
  api.get('/tenant-data/public/exports/:token', async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(1000) }), req.params);
    const file = await openExportDownload(token);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    file.stream.on('error', (err) => {
      logger.warn({ err }, 'Export download stream failed');
      res.destroy(err);
    });
    file.stream.pipe(res);
  });
}

export function tenantDataRoutes(api: Router) {
  publicRoutes(api);
  adminRoutes(api);
  tenantRoutes(api);
}
