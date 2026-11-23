import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import {
  MockPaymentGateway,
  MOCK_SIGNATURE_HEADER,
  signMockWebhook,
} from '../src/infrastructure/payment-gateways/mock.gateway';
import { User } from '../src/modules/users/user.model';
import { PlatformMessage } from '../src/modules/notifications/platform-inbox.models';
import {
  MktCourse,
  MktEnrolment,
  MktOrder,
  MktOrderItem,
  MktSaleLedger,
  MktSeller,
} from '../src/modules/marketplace/models';
import { MktPayoutRun, MktRefund } from '../src/modules/marketplace/payouts.models';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

/** Test mobiles start with 969. */
const PREFIX = '96944';
let seq = 0;
const mobile = () => `${PREFIX}${String(seq++).padStart(5, '0')}`;
const BASE = '/api/marketplace/instructor';
const WEBHOOK = '/api/marketplace/public/webhooks/mock';
const VIDEO = Buffer.from('0000001866747970', 'hex');

let app: Express;
let admin: string;
const sellerIds: number[] = [];

async function newAccount(name: string) {
  const m = mobile();
  const res = await request(app)
    .post('/api/marketplace/public/signup')
    .send({ name, mobile: m, password: DEMO_PASSWORD });
  expect(res.status).toBe(201);
  const user = (await User.findOne({ where: { mobile: m } }))!;
  return { token: (await login({ mobile: m, password: DEMO_PASSWORD })).accessToken, user };
}

async function newSeller(name: string) {
  const a = await newAccount(name);
  await request(app)
    .put('/api/marketplace/instructor-profile')
    .set(bearer(a.token))
    .send({ displayName: name });
  const seller = (await MktSeller.findOne({ where: { userId: a.user.id } }))!;
  sellerIds.push(seller.id);
  return { ...a, seller };
}

async function upload(token: string, kind: 'video' | 'image', data: Buffer, mime: string) {
  const start = await request(app)
    .post(`${BASE}/media`)
    .set(bearer(token))
    .send({ kind, name: `x.${mime.split('/')[1]}`, mimeType: mime, sizeBytes: data.length });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  await request(app)
    .put(`${BASE}/media/${start.body.id}/content?offset=0`)
    .set(bearer(token))
    .set('content-type', 'application/octet-stream')
    .send(data);
  await processDueJobs();
  return start.body.id as number;
}

/** A course ready for review (submitted when `submit`), approved by the admin when `publish`. */
async function course(token: string, pricePaise: number, opts: { submit?: boolean; publish?: boolean } = {}) {
  const cats = await request(app).get('/api/marketplace/public/categories');
  const created = await request(app)
    .post(`${BASE}/courses`)
    .set(bearer(token))
    .send({
      title: `Money course ${mobile()}`,
      subtitle: 'A short subtitle',
      description: 'A description that is comfortably longer than fifty characters in total.',
      categoryId: cats.body[0].id,
      pricePaise,
      outcomes: ['One thing', 'Another thing'],
      thumbnailMediaId: await upload(token, 'image', Buffer.from('\x89PNG fake'), 'image/png'),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
  const section = await request(app)
    .post(`${BASE}/courses/${id}/sections`)
    .set(bearer(token))
    .send({ title: 'Intro' });
  const video = await upload(token, 'video', VIDEO, 'video/mp4');
  await request(app)
    .post(`${BASE}/courses/${id}/sections/${section.body.sections.at(-1).id}/lectures`)
    .set(bearer(token))
    .send({ title: 'Welcome', type: 'video', mediaId: video, preview: true, durationSeconds: 100 });
  if (opts.submit ?? true)
    expect((await request(app).post(`${BASE}/courses/${id}/submit`).set(bearer(token))).status).toBe(200);
  if (opts.publish ?? true)
    expect(
      (await request(app).post(`/api/admin/marketplace/courses/${id}/approve`).set(bearer(admin)).send({}))
        .status,
    ).toBe(200);
  return id;
}

async function checkout(token: string, courseId: number) {
  const res = await request(app)
    .post('/api/marketplace/checkout')
    .set(bearer(token))
    .send({ courseIds: [courseId] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.orderId as number;
}

async function pay(token: string, orderId: number) {
  const res = await request(app)
    .post(`/api/marketplace/orders/${orderId}/mock-complete`)
    .set(bearer(token))
    .send({ outcome: 'success' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.outcome as string;
}

/** Posts a signed mock-gateway payment webhook, as the gateway would. */
async function webhook(order: MktOrder, eventId: string, gatewayPaymentId: string) {
  const body = JSON.stringify({
    eventId,
    gatewayOrderId: order.gatewayOrderId,
    gatewayPaymentId,
    amountPaise: order.totalPaise,
    feePaise: 0,
    status: 'success',
  });
  const res = await request(app)
    .post(WEBHOOK)
    .set('content-type', 'application/json')
    .set(MOCK_SIGNATURE_HEADER, signMockWebhook('mock-webhook-secret', body))
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.outcome as string;
}

const inbox = (userId: number, eventKey: string) => PlatformMessage.findAll({ where: { userId, eventKey } });

async function closeOpenRuns() {
  for (const r of await MktPayoutRun.findAll({ where: { status: 'draft' } }))
    expect(
      (await request(app).post(`/api/admin/marketplace/payout-runs/${r.id}/finalize`).set(bearer(admin)))
        .status,
    ).toBe(200);
}

beforeAll(async () => {
  app = await getApp();
  admin = (await login(USERS.superAdmin)).accessToken;
});

afterAll(async () => {
  await closeOpenRuns();
  // These sellers' earnings must not show up in other suites' payout runs.
  if (sellerIds.length) await MktSaleLedger.destroy({ where: { sellerId: sellerIds, payoutId: null } });
  vi.restoreAllMocks();
});

describe('marketplace payment webhooks', () => {
  it('never re-marks a refunded order as paid, and refunds an extra payment without crediting it', async () => {
    const seller = await newSeller('Webhook Seller');
    const c = await course(seller.token, 60000);
    const buyer = await newAccount('Webhook Buyer');
    const orderId = await checkout(buyer.token, c);
    expect(await pay(buyer.token, orderId)).toBe('paid');
    let order = (await MktOrder.findByPk(orderId))!;
    const paymentId = order.gatewayPaymentId!;

    const refunded = await request(app)
      .post(`/api/admin/marketplace/orders/${orderId}/refund`)
      .set(bearer(admin))
      .send({ reason: 'Customer asked' });
    expect(refunded.body.status).toBe('refunded');

    // the gateway delivers the success again under a new event id
    expect(await webhook(order, `evt_replay_${orderId}`, paymentId)).toBe('already_processed');
    order = (await MktOrder.findByPk(orderId))!;
    expect(order.status).toBe('refunded');
    expect(await MktEnrolment.count({ where: { userId: buyer.user.id, courseId: c } })).toBe(0);
    expect(await MktSaleLedger.count({ where: { orderId, entryType: 'sale' } })).toBe(1);

    // the learner paid the same order again from a stale checkout page
    expect(await webhook(order, `evt_second_${orderId}`, `pay_second_${orderId}`)).toBe('extra_payment');
    expect(await webhook(order, `evt_second_again_${orderId}`, `pay_second_${orderId}`)).toBe(
      'extra_payment',
    );
    const extra = await MktRefund.findAll({ where: { orderId, gatewayPaymentId: { [Op.ne]: null } } });
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({
      status: 'refunded',
      initiatedBy: 'system',
      amountPaise: 60000,
      gatewayPaymentId: `pay_second_${orderId}`,
    });
    expect((await MktOrder.findByPk(orderId))!.status).toBe('refunded');
    expect(await MktSaleLedger.count({ where: { orderId, entryType: 'sale' } })).toBe(1);
    expect(await MktEnrolment.count({ where: { userId: buyer.user.id, courseId: c } })).toBe(0);
  });

  it('credits the seller once when the same course is bought and paid on two orders', async () => {
    const seller = await newSeller('Twice Seller');
    const c = await course(seller.token, 40000);
    const buyer = await newAccount('Twice Buyer');
    const first = await checkout(buyer.token, c);
    // past the 30-minute reuse window, checkout makes a new order
    await getSequelize().query('UPDATE mkt_orders SET created_at = :at WHERE id = :id', {
      replacements: {
        at: new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace('T', ' '),
        id: first,
      },
    });
    const second = await checkout(buyer.token, c);
    expect(second).not.toBe(first);
    expect(await pay(buyer.token, second)).toBe('paid');
    expect(await pay(buyer.token, first)).toBe('paid');

    const sales = await MktSaleLedger.findAll({ where: { courseId: c, entryType: 'sale' } });
    expect(sales.map((s) => s.orderId)).toEqual([second]);
    expect(await MktEnrolment.count({ where: { userId: buyer.user.id, courseId: c } })).toBe(1);
    const refund = (await MktRefund.findOne({ where: { orderId: first } }))!;
    expect(refund).toMatchObject({ status: 'refunded', initiatedBy: 'system', amountPaise: 40000 });
    expect((await MktOrder.findByPk(first))!.status).toBe('refunded');
    expect((await MktOrder.findByPk(second))!.status).toBe('paid');
    expect(await inbox(buyer.user.id, 'marketplace.refund.refunded')).toHaveLength(1);
  });
});

describe('marketplace refunds', () => {
  it('saves a refused refund as failed, blocks a second refund and refunds once on retry', async () => {
    const seller = await newSeller('Failed Refund Seller');
    const c = await course(seller.token, 50000);
    const buyer = await newAccount('Failed Refund Buyer');
    const orderId = await checkout(buyer.token, c);
    await pay(buyer.token, orderId);
    const req = await request(app)
      .post(`/api/marketplace/orders/${orderId}/refunds`)
      .set(bearer(buyer.token))
      .send({ reason: 'Not what I expected' });
    expect(req.status).toBe(201);

    const refundSpy = vi
      .spyOn(MockPaymentGateway.prototype, 'refund')
      .mockRejectedValueOnce(new Error('Insufficient balance for refund'));
    const failed = await request(app)
      .post(`/api/admin/marketplace/refunds/${req.body.id}/approve`)
      .set(bearer(admin))
      .send({});
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ status: 'failed', decisionNote: 'Insufficient balance for refund' });
    expect(await inbox(buyer.user.id, 'marketplace.refund.failed')).toHaveLength(1);

    const failedTab = await request(app)
      .get('/api/admin/marketplace/refunds?status=failed')
      .set(bearer(admin));
    expect(failedTab.body.items.map((r: { id: number }) => r.id)).toContain(req.body.id);

    // the sales page refund can't start a second refund of the same course
    const direct = await request(app)
      .post(`/api/admin/marketplace/orders/${orderId}/refund`)
      .set(bearer(admin))
      .send({ reason: 'Refund again', courseId: c });
    expect(direct.status).toBe(409);
    expect(direct.body.error?.code ?? direct.body.code).toBe('REFUND_FAILED_RETRY');
    expect(
      (
        await request(app)
          .post(`/api/admin/marketplace/refunds/${req.body.id}/approve`)
          .set(bearer(admin))
          .send({})
      ).status,
    ).toBe(409);

    const retried = await request(app)
      .post(`/api/admin/marketplace/refunds/${req.body.id}/retry`)
      .set(bearer(admin));
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('refunded');
    const refundIds = refundSpy.mock.calls.map(([input]) => input.refundId);
    expect(new Set(refundIds)).toEqual(new Set([`mktrf-${req.body.id}`]));
    expect(await MktSaleLedger.count({ where: { orderId, entryType: 'refund' } })).toBe(1);
    expect((await MktOrder.findByPk(orderId))!.status).toBe('refunded');
    expect(await inbox(buyer.user.id, 'marketplace.refund.refunded')).toHaveLength(1);
    expect(
      (await request(app).post(`/api/admin/marketplace/refunds/${req.body.id}/retry`).set(bearer(admin)))
        .status,
    ).toBe(409);
    expect(await MktRefund.count({ where: { orderId } })).toBe(1);
  });

  it('refunds an order only once when two refunds race', async () => {
    const seller = await newSeller('Race Seller');
    const c = await course(seller.token, 30000);
    const buyer = await newAccount('Race Buyer');
    const orderId = await checkout(buyer.token, c);
    await pay(buyer.token, orderId);
    const send = () =>
      request(app)
        .post(`/api/admin/marketplace/orders/${orderId}/refund`)
        .set(bearer(admin))
        .send({ reason: 'Double click' });
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, expect.any(Number)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await MktRefund.count({ where: { orderId } })).toBe(1);
    expect(await MktSaleLedger.count({ where: { orderId, entryType: 'refund' } })).toBe(1);
    expect((await MktOrderItem.findOne({ where: { orderId } }))!.refundId).toBeTruthy();
  });

  it('tells the learner when a refund request is declined', async () => {
    const seller = await newSeller('Reject Seller');
    const c = await course(seller.token, 20000);
    const buyer = await newAccount('Reject Buyer');
    const orderId = await checkout(buyer.token, c);
    await pay(buyer.token, orderId);
    const req = await request(app)
      .post(`/api/marketplace/orders/${orderId}/refunds`)
      .set(bearer(buyer.token))
      .send({ reason: 'Changed my mind' });
    await request(app)
      .post(`/api/admin/marketplace/refunds/${req.body.id}/reject`)
      .set(bearer(admin))
      .send({ note: 'Most of the course was watched' });
    const [note] = await inbox(buyer.user.id, 'marketplace.refund.rejected');
    expect(note.body).toContain('Most of the course was watched');
  });
});

describe('course review and payouts', () => {
  it('lets sellers withdraw a course from review and notifies them of decisions', async () => {
    const seller = await newSeller('Review Seller');
    const c = await course(seller.token, 20000, { publish: false });
    const withdrawn = await request(app).post(`${BASE}/courses/${c}/unpublish`).set(bearer(seller.token));
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe('draft');
    expect(
      (await request(app).post(`/api/admin/marketplace/courses/${c}/approve`).set(bearer(admin)).send({}))
        .status,
    ).toBe(409);

    expect((await request(app).post(`${BASE}/courses/${c}/submit`).set(bearer(seller.token))).status).toBe(
      200,
    );
    await request(app)
      .post(`/api/admin/marketplace/courses/${c}/reject`)
      .set(bearer(admin))
      .send({ reason: 'Add a course summary video' });
    const [rejected] = await inbox(seller.user.id, 'marketplace.course.rejected');
    expect(rejected.body).toContain('Add a course summary video');

    expect((await request(app).post(`${BASE}/courses/${c}/submit`).set(bearer(seller.token))).status).toBe(
      200,
    );
    await request(app).post(`/api/admin/marketplace/courses/${c}/approve`).set(bearer(admin)).send({});
    const [approved] = await inbox(seller.user.id, 'marketplace.course.approved');
    expect(approved.subject).toContain((await MktCourse.findByPk(c))!.title);
  });

  it('holds a suspended seller in the payout run until they are reinstated', async () => {
    await closeOpenRuns();
    const seller = await newSeller('Suspended Seller');
    await request(app)
      .patch(`/api/admin/marketplace/sellers/${seller.seller.id}`)
      .set(bearer(admin))
      .send({ commissionPercent: 30 });
    await request(app)
      .put(`${BASE}/payout-account`)
      .set(bearer(seller.token))
      .send({ method: 'upi', holderName: 'Suspended Seller', upiId: 'suspended.seller@ybl' });
    const c = await course(seller.token, 90000);
    const buyer = await newAccount('Suspended Buyer');
    const orderId = await checkout(buyer.token, c);
    await pay(buyer.token, orderId);
    await getSequelize().query('UPDATE mkt_sale_ledger SET created_at = :at WHERE order_id = :orderId', {
      replacements: { at: new Date(Date.now() - 45 * 86_400_000), orderId },
    });
    await request(app)
      .patch(`/api/admin/marketplace/sellers/${seller.seller.id}`)
      .set(bearer(admin))
      .send({ status: 'suspended' });

    const preview = await request(app).get('/api/admin/marketplace/payout-preview').set(bearer(admin));
    const row = preview.body.rows.find((r: { seller: { id: number } }) => r.seller.id === seller.seller.id);
    expect(row).toMatchObject({ suspended: true, carriedForward: false, netPaise: 63000 });

    const run = await request(app).post('/api/admin/marketplace/payout-runs').set(bearer(admin)).send({});
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const payout = run.body.items.find((p: { seller: { id: number } }) => p.seller.id === seller.seller.id);
    expect(payout).toMatchObject({ status: 'held', holdReason: 'Seller suspended' });
    const release = await request(app)
      .post(`/api/admin/marketplace/payouts/${payout.id}/release`)
      .set(bearer(admin));
    expect(release.status).toBe(409);
    expect(
      (
        await request(app)
          .post(`/api/admin/marketplace/payouts/${payout.id}/paid`)
          .set(bearer(admin))
          .send({ reference: 'UTR1234567' })
      ).status,
    ).toBe(409);

    await request(app)
      .patch(`/api/admin/marketplace/sellers/${seller.seller.id}`)
      .set(bearer(admin))
      .send({ status: 'active' });
    const released = await request(app)
      .post(`/api/admin/marketplace/payouts/${payout.id}/release`)
      .set(bearer(admin));
    expect(released.status).toBe(200);
    expect(released.body.status).toBe('pending');
    await closeOpenRuns();
  });
});
