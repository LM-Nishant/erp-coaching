import { promises as fs } from 'node:fs';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { TALLY_LIMITS } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { AppError } from '../../shared/errors';
import { contentDisposition } from '../../shared/utilities/file-response';
import { uploadMiddleware } from '../files/files.routes';
import { isoDate } from '../fees/util';
import {
  MAX_COMPANY_NAME,
  MAX_VOUCHER_TYPE_NAME,
  clearKnownLedgers,
  createExport,
  exportFile,
  getExport,
  getKnownLedgers,
  getMapping,
  getSettings,
  importKnownLedgers,
  listExports,
  previewExport,
  reconcileExport,
  updateMapping,
  updateSettings,
  type TallyFile,
} from './tally.service';

const can = (action: 'view' | 'configure' | 'export') => requirePermission('tally', action);

const date = z.string().regex(isoDate, 'Use YYYY-MM-DD');
/** `all` = institute-wide / all branches; omitted = the selected branch or the user's default scope. */
const branchQuery = z
  .union([z.literal('all').transform(() => null), z.coerce.number().int().positive()])
  .optional();
const branchBody = z.number().int().positive().nullable().optional();
const boolQ = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');
const text = (max: number) => z.string().trim().max(max);
const voucherTypeName = text(MAX_VOUCHER_TYPE_NAME).nullable().optional();
const tallyName = text(TALLY_LIMITS.maxNameLength);
const period = { from: date, to: date };

function sendXml(res: Response, file: TallyFile) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition('attachment', file.fileName));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file.xml);
}

export function tallyRoutes(api: Router) {
  const r = Router();
  // Exports the fee ledger, so it follows the plan's fees module.
  r.use(authenticate, requireModule('fees'));

  r.get('/settings', can('view'), async (req, res) => {
    const q = parse(z.object({ branchId: branchQuery }), req.query);
    res.json(await getSettings(q.branchId));
  });
  r.put('/settings', can('configure'), async (req, res) => {
    const body = parse(
      z.object({
        branchId: branchBody,
        companyName: text(MAX_COMPANY_NAME).nullable().optional(),
        receivableMode: z.enum(['control', 'party']).nullable().optional(),
        gstLedgers: z.enum(['split', 'single']).nullable().optional(),
        voucherTypes: z
          .object({
            receipt: voucherTypeName,
            payment: voucherTypeName,
            contra: voucherTypeName,
            journal: voucherTypeName,
            feeCharge: voucherTypeName,
          })
          .strict()
          .nullable()
          .optional(),
      }),
      req.body,
    );
    res.json(await updateSettings(body));
  });

  r.get('/mappings', can('view'), async (req, res) => {
    const q = parse(z.object({ branchId: branchQuery }), req.query);
    res.json(await getMapping(q.branchId));
  });
  r.put('/mappings', can('configure'), async (req, res) => {
    const body = parse(
      z.object({
        branchId: branchBody,
        items: z
          .array(
            z.object({
              account: z.string().trim().min(1).max(60),
              tallyName: tallyName.nullable(),
              parentGroup: tallyName.nullable().optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
      req.body,
    );
    res.json(await updateMapping(body));
  });

  // Ledger list exported from Tally (List of Accounts, XML): fills in which ledgers already exist.
  r.post('/known-ledgers', can('configure'), uploadMiddleware, async (req, res) => {
    try {
      const q = parse(z.object({ branchId: branchQuery }), {
        branchId: req.query.branchId ?? req.body?.branchId,
      });
      if (!req.file)
        throw new AppError(
          400,
          'FILE_REQUIRED',
          'Attach the ledger list exported from Tally in the `file` field',
        );
      res
        .status(201)
        .json(await importKnownLedgers(q.branchId, { path: req.file.path, size: req.file.size }));
    } finally {
      if (req.file) await fs.unlink(req.file.path).catch(() => undefined);
    }
  });
  r.get('/known-ledgers', can('view'), async (req, res) => {
    const q = parse(z.object({ branchId: branchQuery, search: text(100).optional() }), req.query);
    res.json(await getKnownLedgers(q.branchId, q.search || undefined));
  });
  r.delete('/known-ledgers', can('configure'), async (req, res) => {
    const q = parse(z.object({ branchId: branchQuery }), req.query);
    res.json(await clearKnownLedgers(q.branchId));
  });

  r.get('/preview', can('export'), async (req, res) => {
    const q = parse(z.object({ ...period, branchId: branchQuery, onlyNew: boolQ }), req.query);
    res.json(await previewExport(q));
  });
  r.post('/exports', can('export'), async (req, res) => {
    const body = parse(
      z.object({ ...period, branchId: branchBody, onlyNew: z.boolean().optional() }),
      req.body,
    );
    res.status(201).json(await createExport(body));
  });
  r.get('/exports', can('view'), async (req, res) => {
    const q = parse(paginationSchema.extend({ branchId: branchQuery }), req.query);
    const { items, total } = await listExports(q);
    res.json(paginated(items, total, q));
  });
  r.get('/exports/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await getExport(id));
  });
  r.get('/exports/:id/reconciliation', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await reconcileExport(id));
  });
  r.get('/exports/:id/masters.xml', can('export'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    sendXml(res, await exportFile(id, 'masters'));
  });
  r.get('/exports/:id/vouchers.xml', can('export'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    sendXml(res, await exportFile(id, 'vouchers'));
  });

  api.use('/tally', r);
}
