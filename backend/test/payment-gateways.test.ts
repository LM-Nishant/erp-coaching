import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { USERS, bearer, getApp, idWatermarks, login, purgeCreatedSince, snapshotRows } from './helpers';
import { config } from '../src/infrastructure/config';
import {
  MockPaymentGateway,
  setPaymentGatewayHttp,
  type GatewayHttpRequest,
} from '../src/infrastructure/payment-gateways';
import {
  generatePaytmChecksum,
  verifyPaytmChecksum,
} from '../src/infrastructure/payment-gateways/paytm-checksum';
import { PAYTM_HOSTS, rawJsonMember } from '../src/infrastructure/payment-gateways/paytm.gateway';
import { FeeLedgerEntry, FeeRefund } from '../src/modules/fees/models';
import { reconcileGatewayPayments } from '../src/modules/fees/payments.service';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { runWithContext } from '../src/shared/context';
import { signCheckoutReturn } from '../src/shared/utilities/checkout-return';

/**
 * Gateway payment flows end to end through the API: checkout, server-side verification (webhook,
 * status check, the payer's return), refunds and reconciliation. Vendor APIs are never called:
 * every request goes to the fake transport below, which answers like the vendor's sandbox.
 */
let seq = 0;
const run = Date.now().toString(36).slice(-6);
const mobile = () => `952${String(Date.now() % 10000).padStart(4, '0')}${String(seq++).padStart(3, '0')}`;
const MINUTE = 60_000;
const MOCK_SECRET = 'whsec_gateway_flows_mock';
const RZP = 'https://api.razorpay.com/v1';
const RZP_KEY = 'rzp_test_GwFlow0001';
const RZP_SECRET = 'rzp-flow-key-secret';
const RZP_WEBHOOK_SECRET = 'rzp-flow-webhook-secret';
const PAYTM_MID = 'GwFlowMID00001';
const PAYTM_KEY = 'GwFl0wMerchKey!#';

type Reply = { status: number; body?: unknown } | Error;
type Route = Reply | ((req: GatewayHttpRequest) => Reply);

/** Fake vendor APIs, matched on method and URL without the query string. */
const vendor = {
  routes: new Map<string, Route>(),
  calls: [] as GatewayHttpRequest[],
  unexpected: [] as string[],
  on(method: 'GET' | 'POST', url: string, route: Route) {
    this.routes.set(`${method} ${url}`, route);
  },
  to(method: 'GET' | 'POST', url: string) {
    return this.calls.filter((c) => c.method === method && c.url.split('?')[0] === url);
  },
};
const sentJson = (req: GatewayHttpRequest) => JSON.parse(req.body ?? 'null');

const CREATED_TABLES = [
  'fee_ledger_entries',
  'fee_webhook_events',
  'fee_payments',
  'fee_accounts',
  'finance_entries',
  'students',
  'users',
  'fee_structures',
  'courses',
  'payment_gateway_configs',
  'fee_settings',
  'notification_messages',
  'jobs',
] as const;
let watermarks: Record<string, number>;
let restoreGateways: () => Promise<void>;
let restoreFeeSettings: () => Promise<void>;

beforeAll(async () => {
  await getApp();
  watermarks = await idWatermarks(CREATED_TABLES);
  restoreGateways = await snapshotRows('payment_gateway_configs', 'institute_id = 1');
  restoreFeeSettings = await snapshotRows('fee_settings', 'institute_id = 1');
  setPaymentGatewayHttp(async (req) => {
    vendor.calls.push(req);
    const route = vendor.routes.get(`${req.method} ${req.url.split('?')[0]}`);
    if (!route) {
      vendor.unexpected.push(`${req.method} ${req.url}`);
      throw new Error('No fake vendor route');
    }
    const reply = typeof route === 'function' ? route(req) : route;
    if (reply instanceof Error) throw reply;
    return { status: reply.status, body: reply.body === undefined ? '' : JSON.stringify(reply.body) };
  });
});

afterEach(() => {
  const unexpected = vendor.unexpected.splice(0);
  expect(unexpected, 'vendor calls without a fake route').toEqual([]);
});

afterAll(async () => {
  setPaymentGatewayHttp(null);
  await purgeCreatedSince(watermarks);
  await restoreGateways();
  await restoreFeeSettings();
});

describe('payment gateway flows', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let accountId: number;
  let studentId: number;
  let mockWebhookPath: string;

  const reconcile = (offsetMs: number) =>
    runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, () =>
      reconcileGatewayPayments(new Date(Date.now() + offsetMs)),
    );
  const payment = async (id: number) => {
    const res = await request(app).get(`/api/fees/payments/${id}`).set(bearer(admin));
    expect(res.status).toBe(200);
    return res.body;
  };
  const account = async () =>
    (await request(app).get(`/api/fees/accounts/${accountId}`).set(bearer(admin))).body;
  const journal = async (key: string) => {
    const lines = await FeeLedgerEntry.findAll({ where: { instituteId: 1, journalKey: key } });
    return {
      lines: lines.length,
      debit: lines.reduce((s, l) => s + l.debit, 0),
      credit: lines.reduce((s, l) => s + l.credit, 0),
    };
  };
  const checkout = async (body: Record<string, unknown>, key = `gw-${run}-${seq++}`) => {
    const res = await request(app)
      .post('/api/fees/payments/checkout')
      .set(bearer(admin))
      .set('Idempotency-Key', key)
      .send({ accountId, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as {
      paymentId: number;
      gatewayOrderId: string;
      amount: number;
      checkout: Record<string, unknown>;
    };
  };
  const returnPath = (c: { checkout: Record<string, unknown> }) =>
    new URL(String(c.checkout.callbackUrl)).pathname;
  const refund = (paymentId: number, key: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/fees/payments/${paymentId}/refund`)
      .set(bearer(admin))
      .set('Idempotency-Key', key)
      .send(body);

  beforeAll(async () => {
    app = await getApp();
    [admin, teacher] = await Promise.all(
      [USERS.apexAdmin, USERS.apexTeacher].map(async (u) => (await login(u)).accessToken),
    );
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: `Gateway Flows ${run}`, code: `GF-${run}` });
    expect(course.status).toBe(201);
    const structure = await request(app)
      .post('/api/fees/structures')
      .set(bearer(admin))
      .send({
        name: `Gateway Flows ${run}`,
        courseId: course.body.id,
        components: [{ name: 'Tuition', amount: 1_000_000 }],
        instalmentPlan: { type: 'one_time' },
      });
    expect(structure.status, JSON.stringify(structure.body)).toBe(201);
    const student = await request(app)
      .post('/api/students')
      .set(bearer(admin))
      .send({ name: 'Gateway Payer', mobile: mobile() });
    expect(student.status).toBe(201);
    studentId = student.body.id;
    const acct = await request(app)
      .post('/api/fees/accounts')
      .set(bearer(admin))
      .send({ studentId, structureId: structure.body.id, firstDueDate: '2030-01-10' });
    expect(acct.status).toBe(201);
    accountId = acct.body.id;
    const gw = await request(app)
      .put('/api/fees/gateways/mock')
      .set(bearer(admin))
      .send({ enabled: true, isDefault: true, webhookSecret: MOCK_SECRET });
    expect(gw.status).toBe(200);
    mockWebhookPath = new URL(gw.body.webhookUrl).pathname;
  });

  describe('mock gateway', () => {
    it('posts a payment whose webhook was lost when reconciliation checks the gateway, once', async () => {
      const before = await account();
      const c = await checkout({ amount: 100_000 });
      // The payer pays, but the webhook never arrives.
      const late = new MockPaymentGateway({ webhookSecret: MOCK_SECRET }).completeCheckout(
        c.gatewayOrderId,
        'success',
      );
      expect((await payment(c.paymentId)).status).toBe('pending');

      // Too new: the payer may still be in the checkout.
      await reconcile(0);
      expect((await payment(c.paymentId)).status).toBe('pending');

      const stats = await reconcile(3 * MINUTE);
      expect(stats.payments).toBeGreaterThanOrEqual(1);
      const posted = await payment(c.paymentId);
      expect(posted).toMatchObject({ status: 'successful', gatewayCharge: 2_000 });
      expect(posted.receiptNumber).toBeTruthy();
      expect(await journal(`payment:${c.paymentId}`)).toMatchObject({ debit: 100_000, credit: 100_000 });
      expect((await account()).paid).toBe(before.paid + 100_000);

      // Another poll, the late webhook and its redelivery change nothing.
      await reconcile(3 * MINUTE);
      const deliver = () =>
        request(app)
          .post(mockWebhookPath)
          .set('Content-Type', 'application/json')
          .set(late.headers)
          .send(late.body);
      expect((await deliver()).body).toMatchObject({ outcome: 'already_processed', paymentId: c.paymentId });
      expect((await deliver()).body.outcome).toBe('duplicate');
      const lines = await journal(`payment:${c.paymentId}`);
      expect(lines).toMatchObject({ debit: 100_000, credit: 100_000 });
      expect((await account()).paid).toBe(before.paid + 100_000);
    });

    it('leaves a fresh failure pending while the payer may retry, then marks it failed', async () => {
      const c = await checkout({ amount: 40_000 });
      new MockPaymentGateway({ webhookSecret: MOCK_SECRET }).completeCheckout(c.gatewayOrderId, 'failed');
      await reconcile(3 * MINUTE);
      expect((await payment(c.paymentId)).status).toBe('pending');
      await reconcile(45 * MINUTE);
      expect((await payment(c.paymentId)).status).toBe('failed');
      expect(await journal(`payment:${c.paymentId}`)).toMatchObject({ lines: 0 });
    });

    it('checks the payment when the payer returns and sends them back to the app', async () => {
      const c = await checkout({ amount: 100_000, returnTo: { platform: 'android', path: '/my-fees' } });
      const path = returnPath(c);
      expect(path).toMatch(/^\/api\/fees\/public\/checkout-return\/[\w-]+\.[\w-]{22}$/);

      // What the gateway posts back is ignored: only the status check counts.
      const posted = await request(app).post(path).type('form').send('STATUS=TXN_SUCCESS&ORDERID=forged');
      expect(posted.status).toBe(303);
      expect(posted.headers.location).toBe(`https://localhost/my-fees?payment=${c.paymentId}`);
      expect(posted.headers['cache-control']).toBe('no-store');
      expect((await payment(c.paymentId)).status).toBe('pending');

      new MockPaymentGateway({ webhookSecret: MOCK_SECRET }).completeCheckout(c.gatewayOrderId, 'success');
      expect((await request(app).get(path)).status).toBe(303);
      expect((await payment(c.paymentId)).status).toBe('successful');

      const target = { instituteId: 1, paymentId: c.paymentId, path: '/my-fees' };
      const ios = await request(app).get(
        `/api/fees/public/checkout-return/${signCheckoutReturn('fees', { ...target, platform: 'ios' })}`,
      );
      expect(ios.status).toBe(200);
      expect(ios.headers['content-type']).toMatch(/text\/html/);
      expect(ios.text).toContain(`capacitor://localhost/my-fees?payment=${c.paymentId}`);
      const web = await request(app).get(
        `/api/fees/public/checkout-return/${signCheckoutReturn('fees', { ...target, platform: 'web' })}`,
      );
      expect(web.status).toBe(303);
      expect(web.headers.location).toBe(`${config.publicWebUrl}/my-fees?payment=${c.paymentId}`);

      const token = signCheckoutReturn('fees', { ...target, platform: 'web' });
      const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      const expired = signCheckoutReturn(
        'fees',
        { ...target, platform: 'web' },
        Date.now() - 8 * 24 * 60 * MINUTE,
      );
      const saas = signCheckoutReturn('saas', { ...target, platform: 'web' });
      for (const bad of [tampered, expired, saas, 'not-a-token']) {
        const res = await request(app).get(`/api/fees/public/checkout-return/${bad}`);
        expect(res.status, bad).toBe(400);
        expect(res.headers.location).toBeUndefined();
      }
    });

    it('is refused in production: no checkout, no simulated completion, no webhook', async () => {
      const c = await checkout({ amount: 10_000 });
      const signed = new MockPaymentGateway({ webhookSecret: MOCK_SECRET }).completeCheckout(
        c.gatewayOrderId,
        'success',
      );
      const previous = config.isProd;
      config.isProd = true;
      try {
        const enable = await request(app)
          .put('/api/fees/gateways/mock')
          .set(bearer(admin))
          .send({ enabled: true, isDefault: true });
        expect(enable.status).toBe(400);
        const open = await request(app)
          .post('/api/fees/payments/checkout')
          .set(bearer(admin))
          .set('Idempotency-Key', `gw-${run}-${seq++}`)
          .send({ accountId, amount: 10_000, gateway: 'mock' });
        expect(open.status).toBe(400);
        const complete = await request(app)
          .post(`/api/fees/payments/${c.paymentId}/mock-complete`)
          .set(bearer(admin))
          .send({});
        expect(complete.status).toBe(404);
        const hook = await request(app)
          .post(mockWebhookPath)
          .set('Content-Type', 'application/json')
          .set(signed.headers)
          .send(signed.body);
        expect(hook.status).toBe(404);
      } finally {
        config.isProd = previous;
      }
      expect((await payment(c.paymentId)).status).toBe('pending');
    });
  });

  describe('Razorpay', () => {
    let webhookPath: string;
    let paymentId: number;
    let orderId: string;
    let payId: string;
    const refunds: Record<string, unknown>[] = [];
    let nextRefundStatus = 'pending';
    const refundList = () => ({
      status: 200,
      body: { entity: 'collection', count: refunds.length, items: refunds },
    });
    const signRzp = (body: string, secret = RZP_WEBHOOK_SECRET) =>
      crypto.createHmac('sha256', secret).update(body).digest('hex');
    const rzpWebhook = (event: Record<string, unknown>, eventId: string, secret?: string) => {
      const body = JSON.stringify(event);
      return request(app)
        .post(webhookPath)
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', signRzp(body, secret))
        .set('X-Razorpay-Event-Id', eventId)
        .send(body);
    };

    it('stores keys encrypted, keeps them when left blank and tests the connection', async () => {
      const put = (body: Record<string, unknown>) =>
        request(app).put('/api/fees/gateways/razorpay').set(bearer(admin)).send(body);
      const missing = await put({ enabled: true, merchantId: RZP_KEY });
      expect(missing.status).toBe(400);

      const saved = await put({
        enabled: true,
        merchantId: RZP_KEY,
        secretKey: RZP_SECRET,
        webhookSecret: RZP_WEBHOOK_SECRET,
        sandbox: true,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body).toMatchObject({
        gateway: 'razorpay',
        enabled: true,
        merchantId: RZP_KEY,
        sandbox: true,
        hasSecret: true,
        hasWebhookSecret: true,
      });
      webhookPath = new URL(saved.body.webhookUrl).pathname;
      expect(webhookPath).toMatch(/^\/api\/fees\/public\/webhooks\/razorpay\/[\w-]{10,}$/);
      const listed = await request(app).get('/api/fees/gateways').set(bearer(admin));
      for (const text of [JSON.stringify(saved.body), JSON.stringify(listed.body)]) {
        expect(text).not.toContain(RZP_SECRET);
        expect(text).not.toContain(RZP_WEBHOOK_SECRET);
      }

      const kept = await put({ merchantId: RZP_KEY, secretKey: '', webhookSecret: '' });
      expect(kept.body).toMatchObject({ hasSecret: true, hasWebhookSecret: true });
      // Live mode is another environment: the saved secret is not carried over.
      const live = await put({ sandbox: false });
      expect(live.status).toBe(400);
      expect(live.body.error.code).toBe('SECRET_REQUIRED');

      const test = () => request(app).post('/api/fees/gateways/razorpay/test').set(bearer(admin));
      vendor.on('GET', `${RZP}/orders`, { status: 200, body: { entity: 'collection', count: 0, items: [] } });
      const ok = await test();
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true, message: 'Connected to Razorpay (test mode)' });
      const [probe] = vendor.to('GET', `${RZP}/orders`);
      expect(probe.url).toBe(`${RZP}/orders?count=1`);
      expect(probe.headers.Authorization).toBe(
        `Basic ${Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString('base64')}`,
      );
      vendor.on('GET', `${RZP}/orders`, {
        status: 401,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } },
      });
      expect((await test()).body).toEqual({
        ok: false,
        message: 'Razorpay rejected the key ID or key secret',
      });
      expect((await request(app).post('/api/fees/gateways/razorpay/test').set(bearer(teacher))).status).toBe(
        403,
      );
    });

    it('opens an order, verifies the payment server-side and ignores webhook replays', async () => {
      orderId = `order_GF${run}`;
      payId = `pay_GF${run}`;
      vendor.on('POST', `${RZP}/orders`, (req) => ({
        status: 200,
        body: {
          id: orderId,
          entity: 'order',
          amount: sentJson(req).amount,
          currency: 'INR',
          status: 'created',
        },
      }));
      const c = await checkout({ amount: 200_000, gateway: 'razorpay', returnTo: { platform: 'web' } });
      paymentId = c.paymentId;
      expect(c).toMatchObject({ gatewayOrderId: orderId, amount: 200_000 });
      expect(c.checkout).toMatchObject({
        provider: 'razorpay',
        key: RZP_KEY,
        orderId,
        amount: 200_000,
        currency: 'INR',
      });
      expect(JSON.stringify(c)).not.toContain(RZP_SECRET);
      expect(sentJson(vendor.to('POST', `${RZP}/orders`)[0])).toMatchObject({
        amount: 200_000,
        currency: 'INR',
        receipt: `1-${paymentId}`,
        notes: { instituteId: '1', paymentId: String(paymentId) },
      });

      // Nothing paid yet.
      const attempts: Record<string, unknown>[] = [];
      vendor.on('GET', `${RZP}/orders/${orderId}/payments`, () => ({
        status: 200,
        body: { entity: 'collection', count: attempts.length, items: attempts },
      }));
      const pending = await request(app).post(`/api/fees/payments/${paymentId}/sync`).set(bearer(admin));
      expect(pending.body).toMatchObject({ outcome: 'pending', payment: { status: 'pending' } });

      // A failed attempt, then a captured one: the captured attempt wins when the payer returns.
      const captured = {
        id: payId,
        entity: 'payment',
        order_id: orderId,
        amount: 200_000,
        currency: 'INR',
        status: 'captured',
        method: 'upi',
        fee: 4_720,
        tax: 720,
        acquirer_data: { rrn: '412345678901' },
        created_at: Math.floor(Date.now() / 1000),
      };
      attempts.push(
        {
          ...captured,
          id: `pay_GF${run}x`,
          status: 'failed',
          fee: null,
          created_at: captured.created_at - 60,
        },
        captured,
      );
      const back = await request(app).get(returnPath(c));
      expect(back.status).toBe(303);
      expect(back.headers.location).toBe(`${config.publicWebUrl}/my-fees?payment=${paymentId}`);
      const paid = await payment(paymentId);
      expect(paid).toMatchObject({
        status: 'successful',
        gatewayPaymentId: payId,
        gatewayCharge: 4_720,
        referenceNo: '412345678901',
      });
      expect(paid.receiptNumber).toBeTruthy();

      const event = {
        entity: 'event',
        event: 'payment.captured',
        payload: { payment: { entity: captured } },
      };
      expect((await rzpWebhook(event, `evt_GF${run}1`)).body).toMatchObject({
        received: true,
        outcome: 'already_processed',
        paymentId,
      });
      expect((await rzpWebhook(event, `evt_GF${run}1`)).body.outcome).toBe('duplicate');
      const forged = await rzpWebhook(event, `evt_GF${run}2`, 'not-the-webhook-secret');
      expect(forged.status).toBe(401);
      expect(forged.body.error.code).toBe('INVALID_SIGNATURE');
      expect(await journal(`payment:${paymentId}`)).toMatchObject({ debit: 200_000, credit: 200_000 });
    });

    it('settles refunds from the request, reconciliation and webhooks exactly once', async () => {
      const listUrl = `${RZP}/payments/${payId}/refunds`;
      const createUrl = `${RZP}/payments/${payId}/refund`;
      vendor.on('GET', listUrl, refundList);
      vendor.on('POST', createUrl, (req) => {
        const sent = sentJson(req);
        const r = {
          id: `rfnd_GF${run}${refunds.length + 1}`,
          entity: 'refund',
          payment_id: payId,
          amount: sent.amount,
          currency: 'INR',
          status: nextRefundStatus,
          receipt: sent.receipt,
          notes: sent.notes,
        };
        refunds.push(r);
        return { status: 200, body: r };
      });
      vendor.on('GET', `${RZP}/refunds/rfnd_GF${run}1`, () => ({ status: 200, body: refunds[0] }));

      // 1. The gateway accepts the refund; it completes later.
      const first = await refund(paymentId, `rzp-rf1-${run}`, { amount: 50_000, reason: 'Course change' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.refund).toMatchObject({ status: 'pending', amount: 50_000 });
      expect(first.body.payment).toMatchObject({ status: 'successful', refunded: 0 });
      const ref = String(refunds[0].receipt);
      expect(ref).toMatch(/^rf1x\d+x[0-9a-f]{8}$/);
      expect(sentJson(vendor.to('POST', createUrl)[0])).toMatchObject({
        amount: 50_000,
        speed: 'normal',
        receipt: ref,
        notes: { reference: ref, note: 'Course change' },
      });
      const sentBefore = vendor.calls.length;
      const replay = await refund(paymentId, `rzp-rf1-${run}`, { amount: 50_000 });
      expect(replay.status).toBe(200);
      expect(replay.body.refund.id).toBe(first.body.refund.id);
      expect(vendor.calls.length).toBe(sentBefore);

      refunds[0].status = 'processed';
      await reconcile(3 * MINUTE);
      const settled = await payment(paymentId);
      expect(settled).toMatchObject({ status: 'partially_refunded', refunded: 50_000 });
      // Settled with no user acting: the audit event still carries the payment's branch.
      const update = await AuditEvent.findOne({
        where: { instituteId: 1, action: 'fees.payment.refund.update', entityId: String(paymentId) },
        order: [['id', 'DESC']],
      });
      expect(update?.branchId).toBe(settled.branchId);
      expect(settled.branchId).toEqual(expect.any(Number));
      expect(await journal(`refund:${first.body.refund.id}`)).toMatchObject({
        debit: 50_000,
        credit: 50_000,
      });
      const processed = {
        entity: 'event',
        event: 'refund.processed',
        payload: { refund: { entity: refunds[0] } },
      };
      expect((await rzpWebhook(processed, `evt_GF${run}r1`)).body).toMatchObject({
        outcome: 'already_processed',
        paymentId,
      });
      expect((await rzpWebhook(processed, `evt_GF${run}r1`)).body.outcome).toBe('duplicate');

      // 2. The request never reaches Razorpay: the refund waits, then is sent again under the same reference.
      vendor.on('GET', listUrl, new Error('socket hang up'));
      const second = await refund(paymentId, `rzp-rf2-${run}`, { amount: 30_000 });
      expect(second.status).toBe(201);
      expect(second.body.refund.status).toBe('pending');
      vendor.on('GET', listUrl, refundList);
      nextRefundStatus = 'processed';
      await reconcile(3 * MINUTE);
      expect(refunds).toHaveLength(1);
      expect(
        (await FeeRefund.findOne({ where: { instituteId: 1, id: second.body.refund.id } }))?.status,
      ).toBe('pending');
      await reconcile(6 * MINUTE);
      expect(refunds).toHaveLength(2);
      expect(refunds[1]).toMatchObject({ amount: 30_000, status: 'processed' });
      expect(String(refunds[1].receipt)).toMatch(new RegExp(`^rf1x${second.body.refund.id}x[0-9a-f]{8}$`));
      expect(await payment(paymentId)).toMatchObject({ status: 'partially_refunded', refunded: 80_000 });
      await reconcile(6 * MINUTE);
      expect(refunds).toHaveLength(2);

      // 3. Razorpay rejects the refund: the admin is told why and nothing is reversed.
      vendor.on('POST', createUrl, {
        status: 400,
        body: {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'Your account does not have enough balance to carry out the refund operation.',
          },
        },
      });
      const rejected = await refund(paymentId, `rzp-rf3-${run}`, { amount: 10_000 });
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toMatchObject({
        code: 'GATEWAY_REFUND_FAILED',
        message:
          'The gateway rejected the refund: Your account does not have enough balance to carry out the refund operation.',
      });
      const after = await payment(paymentId);
      expect(after).toMatchObject({ status: 'partially_refunded', refunded: 80_000 });
      expect(after.refunds.map((r: { status: string }) => r.status)).toEqual([
        'processed',
        'processed',
        'failed',
      ]);
    });
  });

  describe('Paytm', () => {
    let webhookPath: string;
    const signedBody = (req: GatewayHttpRequest) => {
      const sent = sentJson(req) as { body: Record<string, unknown>; head: { signature: string } };
      const raw = rawJsonMember(req.body ?? '', 'body');
      expect(raw && verifyPaytmChecksum(raw, PAYTM_KEY, sent.head.signature)).toBe(true);
      return sent.body;
    };
    const paytmReply = (body: Record<string, unknown>) => ({
      status: 200,
      body: { head: { responseTimestamp: String(Date.now()), version: 'v1', signature: 'x' }, body },
    });

    it('takes a JS checkout payment, verifies the signed callback and settles a refund', async () => {
      const saved = await request(app)
        .put('/api/fees/gateways/paytm')
        .set(bearer(admin))
        .send({ enabled: true, merchantId: PAYTM_MID, secretKey: PAYTM_KEY, sandbox: true });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body).toMatchObject({ gateway: 'paytm', sandbox: true, hasSecret: true });
      expect(JSON.stringify(saved.body)).not.toContain(PAYTM_KEY);
      webhookPath = new URL(saved.body.webhookUrl).pathname;

      const initiateUrl = `${PAYTM_HOSTS.staging.pg}/theia/api/v1/initiateTransaction`;
      vendor.on('POST', initiateUrl, (req) => {
        signedBody(req);
        return paytmReply({
          resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' },
          txnToken: `tok${run}`,
          isPromoCodeValid: false,
          authenticated: false,
        });
      });
      const c = await checkout({ amount: 150_000, gateway: 'paytm', returnTo: { platform: 'android' } });
      expect(c.gatewayOrderId).toMatch(new RegExp(`^1-${c.paymentId}_[0-9a-f]{6}$`));
      expect(c.checkout).toMatchObject({
        provider: 'paytm',
        mid: PAYTM_MID,
        orderId: c.gatewayOrderId,
        txnToken: `tok${run}`,
        amount: '1500.00',
        host: PAYTM_HOSTS.staging.pg,
      });
      const [initiate] = vendor.to('POST', initiateUrl);
      expect(initiate.url).toBe(
        `${initiateUrl}?mid=${PAYTM_MID}&orderId=${encodeURIComponent(c.gatewayOrderId)}`,
      );
      expect(sentJson(initiate).body).toMatchObject({
        requestType: 'Payment',
        mid: PAYTM_MID,
        websiteName: 'WEBSTAGING',
        orderId: c.gatewayOrderId,
        callbackUrl: String(c.checkout.callbackUrl),
        txnAmount: { value: '1500.00', currency: 'INR' },
        userInfo: { custId: `stu${studentId}` },
      });

      // Paytm's server-to-server callback: a form post signed with CHECKSUMHASH.
      const txnId = `2026${run}PTM`;
      const form: Record<string, string> = {
        MID: PAYTM_MID,
        ORDERID: c.gatewayOrderId,
        TXNID: txnId,
        TXNAMOUNT: '1500.00',
        PAYMENTMODE: 'UPI',
        CURRENCY: 'INR',
        TXNDATE: '2026-11-19 12:00:00.0',
        STATUS: 'TXN_SUCCESS',
        RESPCODE: '01',
        RESPMSG: 'Txn Success',
        GATEWAYNAME: 'PPBL',
        BANKTXNID: '631234567890',
      };
      const deliver = (fields: Record<string, string>) =>
        request(app).post(webhookPath).type('form').send(new URLSearchParams(fields).toString());
      const signed = { ...form, CHECKSUMHASH: generatePaytmChecksum(form, PAYTM_KEY) };
      const forged = await deliver({ ...signed, TXNAMOUNT: '1.00' });
      expect(forged.status).toBe(401);
      expect((await deliver(signed)).body).toMatchObject({ outcome: 'posted', paymentId: c.paymentId });
      expect((await deliver(signed)).body.outcome).toBe('duplicate');
      expect(await payment(c.paymentId)).toMatchObject({
        status: 'successful',
        gatewayPaymentId: txnId,
        referenceNo: '631234567890',
      });

      // Refund: Paytm accepts it as pending; reconciliation picks up the final status.
      const refundState: Record<string, unknown> = {};
      vendor.on('POST', `${PAYTM_HOSTS.staging.api}/refund/apply`, (req) => {
        const body = signedBody(req);
        Object.assign(refundState, { refId: body.refId, refundId: `PAYTMRF${run}`, orderId: body.orderId });
        return paytmReply({
          txnTimestamp: '2026-11-19 12:05:00.0',
          orderId: body.orderId,
          mid: PAYTM_MID,
          refId: body.refId,
          resultInfo: {
            resultStatus: 'PENDING',
            resultCode: '601',
            resultMsg: 'Refund request was raised for this transaction. But it is pending state',
          },
          refundId: `PAYTMRF${run}`,
          txnId,
          refundAmount: body.refundAmount,
        });
      });
      vendor.on('POST', `${PAYTM_HOSTS.staging.api}/v2/refund/status`, (req) => {
        const body = signedBody(req);
        expect(body).toMatchObject({ mid: PAYTM_MID, orderId: c.gatewayOrderId, refId: refundState.refId });
        return paytmReply({
          orderId: c.gatewayOrderId,
          mid: PAYTM_MID,
          refId: refundState.refId,
          refundId: refundState.refundId,
          txnId,
          refundAmount: '500.00',
          totalRefundAmount: '500.00',
          resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '10', resultMsg: 'Refund Successfull' },
        });
      });
      const rf = await refund(c.paymentId, `ptm-rf1-${run}`, { amount: 50_000 });
      expect(rf.status, JSON.stringify(rf.body)).toBe(201);
      expect(rf.body.refund).toMatchObject({ status: 'pending', gatewayRefundId: `PAYTMRF${run}` });
      expect(sentJson(vendor.to('POST', `${PAYTM_HOSTS.staging.api}/refund/apply`)[0]).body).toMatchObject({
        mid: PAYTM_MID,
        txnType: 'REFUND',
        orderId: c.gatewayOrderId,
        txnId,
        refundAmount: '500.00',
      });
      await reconcile(3 * MINUTE);
      expect(await payment(c.paymentId)).toMatchObject({ status: 'partially_refunded', refunded: 50_000 });

      // Paytm's refund webhook (JSON, signed over "body") is confirmed with the status API, which reports
      // the same refund status reconciliation already recorded.
      const hookBody = JSON.stringify({
        mid: PAYTM_MID,
        orderId: c.gatewayOrderId,
        txnId,
        refId: refundState.refId,
        refundId: refundState.refundId,
        refundAmount: '500.00',
        status: 'SUCCESS',
      });
      const hook = await request(app)
        .post(webhookPath)
        .set('Content-Type', 'application/json')
        .send(`{"head":{"signature":"${generatePaytmChecksum(hookBody, PAYTM_KEY)}"},"body":${hookBody}}`);
      expect(hook.status, JSON.stringify(hook.body)).toBe(200);
      expect(hook.body).toMatchObject({ outcome: 'duplicate', paymentId: c.paymentId });
      expect(await payment(c.paymentId)).toMatchObject({ status: 'partially_refunded', refunded: 50_000 });
      expect(await journal(`refund:${rf.body.refund.id}`)).toMatchObject({ debit: 50_000, credit: 50_000 });
    });
  });
});
