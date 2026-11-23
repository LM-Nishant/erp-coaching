import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  MKT_PAYOUT_METHODS,
  MKT_REFUND_STATUSES,
  MKT_REVENUE_GROUPS,
  type PermissionAction,
} from '@erp/shared';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { idParam } from '../../shared/utilities/pagination';
import { parse } from '../../shared/utilities/validation';
import * as payouts from './payouts.service';
import * as refunds from './refunds.service';
import * as revenue from './revenue.service';
import * as sellers from './sellers.service';
import { MARKETPLACE } from './util';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const reason = (max: number) => z.string().trim().min(3).max(max);
const optNote = z.string().trim().max(1000).nullable().optional();
const refundInput = z.object({
  courseId: z.number().int().positive().nullable().optional(),
  reason: reason(1000),
});

function sendCsv(res: Response, file: { filename: string; body: string }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[^\w.-]+/g, '-')}"`);
  res.setHeader('Cache-Control', 'no-store');
  // BOM so Excel reads ₹ and names correctly.
  res.send(`\uFEFF${file.body}`);
}

type Guard = (action: PermissionAction) => RequestHandler[];

/** Seller revenue, payout details and statements; mounted for instructors and institute storefronts. */
function studioRoutes(scope: sellers.SellerScope, can: Guard): Router {
  const r = Router();
  const seller = async () => (await sellers.currentSeller(scope)).id;

  r.get('/revenue', ...can('view'), async (req, res) => {
    const q = parse(
      z.object({ from: day.optional(), to: day.optional(), groupBy: z.enum(MKT_REVENUE_GROUPS).optional() }),
      req.query,
    );
    res.json(await revenue.sellerRevenue(await seller(), q));
  });
  r.get('/payout-account', ...can('view'), async (_req, res) => {
    res.json({ account: await payouts.getPayoutAccount(await seller()) });
  });
  r.put('/payout-account', ...can('configure'), async (req, res) => {
    const body = parse(
      z.object({
        method: z.enum(MKT_PAYOUT_METHODS),
        holderName: z.string().trim().min(2).max(150),
        bankName: z.string().trim().max(150).nullable().optional(),
        accountNumber: z.string().trim().max(30).nullable().optional(),
        ifsc: z.string().trim().max(11).nullable().optional(),
        upiId: z.string().trim().max(256).nullable().optional(),
      }),
      req.body,
    );
    res.json(await payouts.savePayoutAccount(await seller(), body));
  });
  r.get('/payouts', ...can('view'), async (_req, res) => {
    res.json(await payouts.sellerPayouts(await seller()));
  });
  r.get('/payouts/:id', ...can('view'), async (req, res) => {
    res.json(await payouts.sellerPayout(await seller(), parse(idParam, req.params).id));
  });
  r.get('/payouts/:id/statement.csv', ...can('view'), async (req, res) => {
    sendCsv(res, await payouts.sellerStatementCsv(await seller(), parse(idParam, req.params).id));
  });
  return r;
}

function adminRoutes(api: Router) {
  const a = Router();
  a.use(authenticate, requireSuperAdmin);

  a.get('/payout-settings', async (_req, res) => {
    res.json(await payouts.getPayoutSettings());
  });
  a.put('/payout-settings', async (req, res) => {
    const body = parse(
      z.object({
        minPayoutPaise: z.number().int().min(0).max(100_000_000).optional(),
        holdDays: z.number().int().min(0).max(180).optional(),
        refundWindowDays: z.number().int().min(0).max(180).optional(),
      }),
      req.body,
    );
    res.json(await payouts.updatePayoutSettings(body));
  });

  a.get('/payout-preview', async (req, res) => {
    const { periodEnd } = parse(z.object({ periodEnd: day.optional() }), req.query);
    res.json(await payouts.previewPayouts(periodEnd));
  });
  a.get('/payout-runs', async (_req, res) => {
    res.json(await payouts.listRuns());
  });
  a.post('/payout-runs', async (req, res) => {
    const { periodEnd } = parse(z.object({ periodEnd: day.optional() }), req.body ?? {});
    res.status(201).json(await payouts.createRun(periodEnd));
  });
  a.get('/payout-runs/:id', async (req, res) => {
    res.json(await payouts.getRun(parse(idParam, req.params).id));
  });
  a.get('/payout-runs/:id/export.csv', async (req, res) => {
    sendCsv(res, await payouts.exportRunCsv(parse(idParam, req.params).id));
  });
  a.post('/payout-runs/:id/finalize', async (req, res) => {
    res.json(await payouts.finalizeRun(parse(idParam, req.params).id));
  });
  a.post('/payout-runs/:id/cancel', async (req, res) => {
    res.json(await payouts.cancelRun(parse(idParam, req.params).id));
  });

  a.get('/payouts/:id/account', async (req, res) => {
    res.json(await payouts.revealPayoutAccount(parse(idParam, req.params).id));
  });
  a.post('/payouts/:id/paid', async (req, res) => {
    const body = parse(
      z.object({
        reference: z
          .string()
          .trim()
          .min(4)
          .max(80)
          .regex(/^[A-Za-z0-9/_.-]+$/, 'Use the UTR or UPI reference (letters, digits, - / _ .)'),
        paidAt: z.string().datetime({ offset: true }).nullable().optional(),
      }),
      req.body,
    );
    res.json(await payouts.markPaid(parse(idParam, req.params).id, body));
  });
  a.post('/payouts/:id/hold', async (req, res) => {
    const { reason: why } = parse(z.object({ reason: reason(300) }), req.body ?? {});
    res.json(await payouts.holdPayout(parse(idParam, req.params).id, why));
  });
  a.post('/payouts/:id/release', async (req, res) => {
    res.json(await payouts.releasePayout(parse(idParam, req.params).id));
  });
  a.post('/payouts/:id/cancel', async (req, res) => {
    const { reason: why } = parse(z.object({ reason: optNote }), req.body ?? {});
    res.json(await payouts.cancelPayout(parse(idParam, req.params).id, why));
  });

  a.get('/refunds', async (req, res) => {
    const q = parse(
      z.object({
        status: z.enum(MKT_REFUND_STATUSES).optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    );
    res.json(await refunds.listRefunds(q));
  });
  a.post('/refunds/:id/approve', async (req, res) => {
    const { note } = parse(z.object({ note: optNote }), req.body ?? {});
    res.json(await refunds.approveRefund(parse(idParam, req.params).id, note));
  });
  a.post('/refunds/:id/reject', async (req, res) => {
    const { note } = parse(z.object({ note: reason(1000) }), req.body ?? {});
    res.json(await refunds.rejectRefund(parse(idParam, req.params).id, note));
  });
  a.post('/orders/:id/refund', async (req, res) => {
    res.json(await refunds.adminRefundOrder(parse(idParam, req.params).id, parse(refundInput, req.body)));
  });

  api.use('/admin/marketplace', a);
}

function learnerRoutes(api: Router) {
  const r = Router();
  r.get('/orders/:id/refunds', authenticate, async (req, res) => {
    res.json(await refunds.orderRefunds(parse(idParam, req.params).id));
  });
  r.post('/orders/:id/refunds', authenticate, async (req, res) => {
    res
      .status(201)
      .json(await refunds.requestRefund(parse(idParam, req.params).id, parse(refundInput, req.body)));
  });
  api.use('/marketplace', r);
}

/** Revenue, payouts and refunds (wave 2). Mounted next to the core marketplace routes. */
export function payoutRoutes(api: Router) {
  adminRoutes(api);
  learnerRoutes(api);
  api.use(
    '/marketplace/instructor',
    authenticate,
    studioRoutes('instructor', () => []),
  );
  api.use(
    '/marketplace/institute',
    authenticate,
    studioRoutes('institute', (action) => [requirePermission(MARKETPLACE, action)]),
  );
}
