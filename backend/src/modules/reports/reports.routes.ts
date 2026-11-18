import { Router } from 'express';
import { z } from 'zod';
import { REPORT_EXPORT_FORMATS } from '@erp/shared';
import { audit } from '../../shared/audit/audit.service';
import { authenticate } from '../../shared/middleware/authenticate';
import {
  requireModule,
  requirePermission,
  requireSuperAdmin,
  requireTenant,
} from '../../shared/middleware/authorize';
import { idParam } from '../../shared/utilities/pagination';
import { parse } from '../../shared/utilities/validation';
import { roleDashboard } from './dashboard.service';
import { SCREEN_ROW_LIMIT, availableReports, catalogItem, prepareReport, runReport } from './definitions';
import { createExport, downloadExport, getExport, listExports } from './exports.service';
import { createExportSchema, reportFiltersSchema } from './filters';
import { renderReport } from './render';
import { saasDashboard, saasExportDocument } from './saas';
import { reportFilterOptions } from './scope';

const M = 'reports';
/** Institutes included in the platform export. */
const SAAS_EXPORT_LIMIT = 50_000;

const keyParam = z.object({ key: z.string().regex(/^[a-z-]{1,40}$/, 'Unknown report') });
const saasExportQuery = reportFiltersSchema
  .pick({ preset: true, from: true, to: true })
  .extend({ format: z.enum(REPORT_EXPORT_FORMATS) });

export function reportsRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireTenant, requireModule(M), requirePermission(M, 'view'));

  r.get('/catalog', async (_req, res) => {
    res.json((await availableReports()).map(catalogItem));
  });

  r.get('/filters', async (_req, res) => {
    res.json(await reportFilterOptions());
  });

  r.get('/dashboard', async (req, res) => {
    res.json(await roleDashboard(parse(reportFiltersSchema, req.query)));
  });

  r.get('/exports', async (_req, res) => {
    res.json(await listExports());
  });

  r.get('/exports/:id', async (req, res) => {
    res.json(await getExport(parse(idParam, req.params).id));
  });

  // POST: every download is signed and audited separately.
  r.post('/exports/:id/download', requirePermission(M, 'export'), async (req, res) => {
    res.json(await downloadExport(parse(idParam, req.params).id));
  });

  r.post('/:key/exports', requirePermission(M, 'export'), async (req, res) => {
    const { key } = parse(keyParam, req.params);
    const { queued, dto } = await createExport(key, parse(createExportSchema, req.body ?? {}));
    res.status(queued ? 202 : 201).json(dto);
  });

  r.get('/:key', async (req, res) => {
    const { key } = parse(keyParam, req.params);
    const { def, req: request } = await prepareReport(
      key,
      parse(reportFiltersSchema, req.query),
      SCREEN_ROW_LIMIT,
    );
    res.json(await runReport(def, request));
  });

  api.use('/reports', r);

  // Platform (super admin) analytics across every institute.
  const admin = Router();
  admin.use(authenticate, requireSuperAdmin);

  admin.get('/dashboard', async (req, res) => {
    res.json(
      await saasDashboard(parse(reportFiltersSchema.pick({ preset: true, from: true, to: true }), req.query)),
    );
  });

  admin.get('/institutes/export', async (req, res) => {
    const { format, ...filters } = parse(saasExportQuery, req.query);
    const dash = await saasDashboard(filters, { tableLimit: SAAS_EXPORT_LIMIT });
    const rendered = renderReport(saasExportDocument(dash), format, { instituteName: 'Coaching ERP' });
    await audit({
      action: 'report.saas_exported',
      entityType: 'report',
      entityId: 'saas-institutes',
      instituteId: null,
      metadata: {
        format,
        period: { from: dash.period.from, to: dash.period.to },
        institutes: dash.institutes.total,
      },
    });
    res.setHeader('Content-Type', rendered.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${rendered.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(rendered.buffer);
  });

  api.use('/admin/reports', admin);
}
