import request from 'supertest';
import type { Express } from 'express';
import { QueryTypes } from 'sequelize';
import { beforeAll, describe, expect, it } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { User } from '../src/modules/users/user.model';
import { NotificationMessage } from '../src/modules/notifications/models';
import { MktEnrolment, MktSaleLedger, MktSeller } from '../src/modules/marketplace/models';
import { MktPayout, MktPayoutAccount, MktPayoutRun } from '../src/modules/marketplace/payouts.models';
import { csvField } from '../src/modules/marketplace/payouts.service';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

/** Test mobiles start with 967 (the payout demo learners are 96700000xx). */
let seq = 0;
const mobile = () => `96711${String(seq++).padStart(5, '0')}`;
const BASE = '/api/marketplace/instructor';
const VIDEO = Buffer.from('0000001866747970', 'hex');

let app: Express;
let admin: string;

async function newAccount(name: string) {
  const m = mobile();
  const res = await request(app)
    .post('/api/marketplace/public/signup')
    .send({ name, mobile: m, password: DEMO_PASSWORD });
  expect(res.status).toBe(201);
  return (await login({ mobile: m, password: DEMO_PASSWORD })).accessToken;
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

/** A published course in the instructor's studio. */
async function course(token: string, pricePaise: number) {
  const cats = await request(app).get('/api/marketplace/public/categories');
  const created = await request(app)
    .post(`${BASE}/courses`)
    .set(bearer(token))
    .send({
      title: `Payout course ${mobile()}`,
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
  for (const l of [
    { title: 'Welcome', type: 'video', mediaId: video, preview: true, durationSeconds: 100 },
    { title: 'Read me', type: 'article', articleBody: 'Hello learners' },
  ])
    await request(app)
      .post(`${BASE}/courses/${id}/sections/${section.body.sections.at(-1).id}/lectures`)
      .set(bearer(token))
      .send(l);
  expect((await request(app).post(`${BASE}/courses/${id}/submit`).set(bearer(token))).status).toBe(200);
  await request(app).post(`/api/admin/marketplace/courses/${id}/approve`).set(bearer(admin)).send({});
  return id;
}

async function buy(token: string, courseId: number) {
  const checkout = await request(app)
    .post('/api/marketplace/checkout')
    .set(bearer(token))
    .send({ courseIds: [courseId] });
  expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
  await request(app)
    .post(`/api/marketplace/orders/${checkout.body.orderId}/mock-complete`)
    .set(bearer(token))
    .send({ outcome: 'success' });
  return checkout.body.orderId as number;
}

/** Moves an order's payment and its ledger rows into the past. */
async function backdate(orderId: number, days: number) {
  const at = new Date(Date.now() - days * 86_400_000);
  const q = getSequelize();
  await q.query('UPDATE mkt_orders SET paid_at = :at WHERE id = :orderId', { replacements: { at, orderId } });
  await q.query('UPDATE mkt_sale_ledger SET created_at = :at WHERE order_id = :orderId', {
    replacements: { at, orderId },
  });
}

/** Cancels any open run so each test starts from a clean slate. */
async function closeOpenRuns() {
  for (const r of await MktPayoutRun.findAll({ where: { status: 'draft' } })) {
    const res = await request(app)
      .post(`/api/admin/marketplace/payout-runs/${r.id}/finalize`)
      .set(bearer(admin));
    expect(res.status).toBe(200);
  }
}

beforeAll(async () => {
  app = await getApp();
  admin = (await login(USERS.superAdmin)).accessToken;
});

describe('demo payouts seed', () => {
  it('gives Riya a paid payout, encrypted bank details and pending earnings', async () => {
    const riya = (await login({ mobile: '9640000001', password: DEMO_PASSWORD })).accessToken;
    const rev = await request(app).get(`${BASE}/revenue`).set(bearer(riya));
    expect(rev.status).toBe(200);
    expect(rev.body.balance.paidPaise).toBeGreaterThan(0);
    expect(rev.body.balance.pendingPaise).toBeGreaterThan(0);
    expect(rev.body.hasPayoutAccount).toBe(true);
    expect(rev.body.courses.some((c: { refunds: number }) => c.refunds === 1)).toBe(true);

    const account = await request(app).get(`${BASE}/payout-account`).set(bearer(riya));
    expect(account.body.account).toMatchObject({
      method: 'bank',
      maskedAccount: 'XXXX7812',
      ifsc: 'HDFC0001234',
    });
    expect(JSON.stringify(account.body)).not.toContain('50100234567812');
    const [raw] = await getSequelize().query<{ account_encrypted: string }>(
      'SELECT account_encrypted FROM mkt_payout_accounts WHERE masked = :m',
      { type: QueryTypes.SELECT, replacements: { m: 'XXXX7812' } },
    );
    expect(raw.account_encrypted).not.toContain('50100234567812');

    const payouts = await request(app).get(`${BASE}/payouts`).set(bearer(riya));
    expect(payouts.body[0]).toMatchObject({ status: 'paid', reference: 'HDFCN52026110712345' });
    const detail = await request(app).get(`${BASE}/payouts/${payouts.body[0].id}`).set(bearer(riya));
    expect(detail.body.lines.length).toBe(detail.body.entries);
  });
});

describe('seller payout details', () => {
  it('validates, masks and encrypts bank and UPI details', async () => {
    const seller = await newAccount('Details Seller');
    await request(app)
      .put('/api/marketplace/instructor-profile')
      .set(bearer(seller))
      .send({ displayName: 'Details Seller' });
    const bad = await request(app)
      .put(`${BASE}/payout-account`)
      .set(bearer(seller))
      .send({ method: 'bank', holderName: 'D S', accountNumber: '1234567890', ifsc: 'BAD' });
    expect(bad.status).toBe(400);
    const upi = await request(app)
      .put(`${BASE}/payout-account`)
      .set(bearer(seller))
      .send({ method: 'upi', holderName: 'D S', upiId: 'details.seller@okaxis' });
    expect(upi.status, JSON.stringify(upi.body)).toBe(200);
    expect(upi.body).toMatchObject({ method: 'upi', maskedAccount: 'de••••@okaxis', ifsc: null });
    // learners without a seller profile have no studio
    const learner = await newAccount('Plain Learner');
    expect((await request(app).get(`${BASE}/revenue`).set(bearer(learner))).status).toBe(404);
  });

  it('neutralises spreadsheet formulas in CSV cells', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField(1234)).toBe('1234');
  });
});

describe('payout runs and refunds', () => {
  it('groups unpaid earnings, honours the hold window and threshold, pays and exports', async () => {
    await closeOpenRuns();
    const seller = await newAccount('Payout Seller');
    await request(app)
      .put('/api/marketplace/instructor-profile')
      .set(bearer(seller))
      .send({ displayName: 'Payout Seller' });
    const sellerRow = (await MktSeller.findOne({ where: { displayName: 'Payout Seller' } }))!;
    await request(app)
      .patch(`/api/admin/marketplace/sellers/${sellerRow.id}`)
      .set(bearer(admin))
      .send({ commissionPercent: 20 });
    const a = await course(seller, 100000);
    const b = await course(seller, 50000);

    const old1 = await buy(await newAccount('Buyer A'), a);
    const old2 = await buy(await newAccount('Buyer B'), b);
    const recent = await buy(await newAccount('Buyer C'), a);
    await backdate(old1, 45);
    await backdate(old2, 40);

    const rev = await request(app).get(`${BASE}/revenue`).set(bearer(seller));
    expect(rev.body.totals).toMatchObject({
      grossPaise: 250000,
      commissionPaise: 50000,
      netPaise: 200000,
      sales: 3,
    });
    expect(rev.body.series).toHaveLength(12);
    const daily = await request(app).get(`${BASE}/revenue?groupBy=day`).set(bearer(seller));
    expect(daily.body.series).toHaveLength(30);
    expect(daily.body.totals.sales).toBe(1);
    expect(rev.body.courses.find((c: { courseId: number }) => c.courseId === a)).toMatchObject({
      sales: 2,
      enrolments: 2,
    });
    expect(rev.body.balance).toMatchObject({ pendingPaise: 200000, paidPaise: 0 });

    // threshold: the seller is carried forward
    await request(app)
      .put('/api/admin/marketplace/payout-settings')
      .set(bearer(admin))
      .send({ minPayoutPaise: 500000 });
    let preview = await request(app).get('/api/admin/marketplace/payout-preview').set(bearer(admin));
    const mine = () =>
      preview.body.rows.find((r: { seller: { id: number } }) => r.seller.id === sellerRow.id);
    expect(mine()).toMatchObject({ netPaise: 120000, carriedForward: true, hasAccount: false });
    await request(app)
      .put('/api/admin/marketplace/payout-settings')
      .set(bearer(admin))
      .send({ minPayoutPaise: 50000 });
    preview = await request(app).get('/api/admin/marketplace/payout-preview').set(bearer(admin));
    // only the two sales older than the 30-day hold window
    expect(mine()).toMatchObject({
      grossPaise: 150000,
      commissionPaise: 30000,
      netPaise: 120000,
      entries: 2,
      carriedForward: false,
    });

    // no payout details yet → held
    const created = await request(app).post('/api/admin/marketplace/payout-runs').set(bearer(admin)).send({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(
      (await request(app).post('/api/admin/marketplace/payout-runs').set(bearer(admin)).send({})).status,
    ).toBe(409);
    const runId = created.body.id as number;
    const payout = created.body.items.find((p: { seller: { id: number } }) => p.seller.id === sellerRow.id);
    expect(payout).toMatchObject({ status: 'held', holdReason: 'No payout details', netPaise: 120000 });
    expect(await MktSaleLedger.count({ where: { payoutId: payout.id } })).toBe(2);
    expect(await MktSaleLedger.count({ where: { orderId: recent, payoutId: null } })).toBe(1);

    const pay = (reference: string) =>
      request(app)
        .post(`/api/admin/marketplace/payouts/${payout.id}/paid`)
        .set(bearer(admin))
        .send({ reference });
    expect((await pay('UTR123456')).status).toBe(409);
    await request(app).put(`${BASE}/payout-account`).set(bearer(seller)).send({
      method: 'bank',
      holderName: 'Payout Seller',
      bankName: 'SBI',
      accountNumber: '3216549870123',
      ifsc: 'SBIN0004321',
    });
    await request(app).post(`/api/admin/marketplace/payouts/${payout.id}/release`).set(bearer(admin));
    const reveal = await request(app)
      .get(`/api/admin/marketplace/payouts/${payout.id}/account`)
      .set(bearer(admin));
    expect(reveal.body.accountNumber).toBe('3216549870123');
    expect(
      (await request(app).get(`/api/admin/marketplace/payouts/${payout.id}/account`).set(bearer(seller)))
        .status,
    ).toBe(403);

    const csv = await request(app)
      .get(`/api/admin/marketplace/payout-runs/${runId}/export.csv`)
      .set(bearer(admin));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('3216549870123');
    expect(csv.text).toContain('SBIN0004321');

    expect((await pay('bad ref!')).status).toBe(422);
    const paid = await pay('SBIN52026112300001');
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ status: 'paid', reference: 'SBIN52026112300001' });
    expect(paid.body.paidTo).toContain('XXXX0123');
    expect((await pay('SBIN52026112300001')).status).toBe(409);

    const balance = (await request(app).get(`${BASE}/revenue`).set(bearer(seller))).body.balance;
    expect(balance).toMatchObject({ paidPaise: 120000, pendingPaise: 80000 });
    const statement = await request(app)
      .get(`${BASE}/payouts/${payout.id}/statement.csv`)
      .set(bearer(seller));
    expect(statement.text).toContain('SBIN52026112300001');
    expect(statement.text).not.toContain('3216549870123');

    // cancelling other open payouts returns their rows to the pending balance
    const run = await request(app).get(`/api/admin/marketplace/payout-runs/${runId}`).set(bearer(admin));
    expect(
      (await request(app).post(`/api/admin/marketplace/payout-runs/${runId}/cancel`).set(bearer(admin)))
        .status,
    ).toBe(409);
    for (const p of run.body.items.filter((x: { status: string }) => x.status !== 'paid')) {
      await request(app).post(`/api/admin/marketplace/payouts/${p.id}/cancel`).set(bearer(admin)).send({});
      expect(await MktSaleLedger.count({ where: { payoutId: p.id } })).toBe(0);
    }
    expect((await MktPayoutRun.findByPk(runId))!.status).toBe('finalized');
  });

  it('lets learners request refunds in the window; approval reverses the sale and nets out of the next payout', async () => {
    await closeOpenRuns();
    const seller = await newAccount('Refund Seller');
    await request(app)
      .put('/api/marketplace/instructor-profile')
      .set(bearer(seller))
      .send({ displayName: 'Refund Seller' });
    const sellerRow = (await MktSeller.findOne({ where: { displayName: 'Refund Seller' } }))!;
    await request(app)
      .patch(`/api/admin/marketplace/sellers/${sellerRow.id}`)
      .set(bearer(admin))
      .send({ commissionPercent: 30 });
    await request(app)
      .put(`${BASE}/payout-account`)
      .set(bearer(seller))
      .send({ method: 'upi', holderName: 'Refund Seller', upiId: 'refund.seller@ybl' });
    const c = await course(seller, 80000);
    const buyerA = await newAccount('Refund Buyer A');
    const buyerB = await newAccount('Refund Buyer B');
    const buyerC = await newAccount('Refund Buyer C');
    const late = await buy(buyerA, c);
    const orderB = await buy(buyerB, c);
    const orderC = await buy(buyerC, c);
    await backdate(late, 45);

    // outside the window
    const tooLate = await request(app)
      .post(`/api/marketplace/orders/${late}/refunds`)
      .set(bearer(buyerA))
      .send({ reason: 'Changed my mind' });
    expect(tooLate.status).toBe(400);
    expect(
      (await request(app).get(`/api/marketplace/orders/${late}/refunds`).set(bearer(buyerA))).body
        .refundableCourseIds,
    ).toEqual([]);
    // only the buyer can ask
    expect(
      (
        await request(app)
          .post(`/api/marketplace/orders/${orderB}/refunds`)
          .set(bearer(buyerA))
          .send({ reason: 'Not mine' })
      ).status,
    ).toBe(404);

    const reqB = await request(app)
      .post(`/api/marketplace/orders/${orderB}/refunds`)
      .set(bearer(buyerB))
      .send({ reason: 'Course is not what I expected' });
    expect(reqB.status, JSON.stringify(reqB.body)).toBe(201);
    expect(reqB.body).toMatchObject({ status: 'requested', amountPaise: 80000 });
    expect(
      (
        await request(app)
          .post(`/api/marketplace/orders/${orderB}/refunds`)
          .set(bearer(buyerB))
          .send({ reason: 'Again please' })
      ).status,
    ).toBe(409);
    const reqC = await request(app)
      .post(`/api/marketplace/orders/${orderC}/refunds`)
      .set(bearer(buyerC))
      .send({ reason: 'Bought by accident' });

    const list = await request(app).get('/api/admin/marketplace/refunds?status=requested').set(bearer(admin));
    expect(list.body.items.map((r: { id: number }) => r.id)).toEqual(
      expect.arrayContaining([reqB.body.id, reqC.body.id]),
    );

    const rejected = await request(app)
      .post(`/api/admin/marketplace/refunds/${reqC.body.id}/reject`)
      .set(bearer(admin))
      .send({ note: 'Most of the course was watched' });
    expect(rejected.body.status).toBe('rejected');

    const approved = await request(app)
      .post(`/api/admin/marketplace/refunds/${reqB.body.id}/approve`)
      .set(bearer(admin))
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('refunded');
    expect(approved.body.gatewayRefundId).toBeTruthy();
    const buyerBUser = (await User.findOne({
      where: {
        id: (
          await getSequelize().query<{ user_id: number }>('SELECT user_id FROM mkt_orders WHERE id = :id', {
            type: QueryTypes.SELECT,
            replacements: { id: orderB },
          })
        )[0].user_id,
      },
    }))!;
    expect(await MktEnrolment.count({ where: { userId: buyerBUser.id, courseId: c } })).toBe(0);
    const order = await request(app).get(`/api/marketplace/orders/${orderB}`).set(bearer(buyerB));
    expect(order.body.status).toBe('refunded');
    expect(await MktSaleLedger.count({ where: { orderId: orderB, entryType: 'refund' } })).toBe(1);

    // admin refund of the old order (no window), then the next run nets the refunds out
    const direct = await request(app)
      .post(`/api/admin/marketplace/orders/${late}/refund`)
      .set(bearer(admin))
      .send({ reason: 'Duplicate purchase' });
    expect(direct.body.status).toBe('refunded');

    const rev = (await request(app).get(`${BASE}/revenue`).set(bearer(seller))).body;
    expect(rev.totals).toMatchObject({
      sales: 3,
      refunds: 2,
      grossPaise: 80000,
      refundedPaise: 160000,
      netPaise: 56000,
    });
    expect(rev.balance.pendingPaise).toBe(56000); // one sale left after two refunds
    expect(rev.balance.onHoldPaise).toBe(56000); // refunded sales are never on hold

    // the refunded sales and their reversals cancel out; the remaining sale is still on hold
    const preview = await request(app).get('/api/admin/marketplace/payout-preview').set(bearer(admin));
    const row = preview.body.rows.find((r: { seller: { id: number } }) => r.seller.id === sellerRow.id);
    expect(row).toMatchObject({ netPaise: 0, entries: 4, carriedForward: true });
  });

  it('notifies an institute storefront when its payout is paid', async () => {
    await closeOpenRuns();
    const apexAdmin = (await login(USERS.apexAdmin)).accessToken;
    const save = await request(app)
      .put('/api/marketplace/institute/payout-account')
      .set(bearer(apexAdmin))
      .send({
        method: 'bank',
        holderName: 'Apex Coaching Classes',
        bankName: 'ICICI',
        accountNumber: '000401234567',
        ifsc: 'ICIC0000004',
      });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    const teacher = (await login(USERS.apexTeacher)).accessToken;
    expect(
      (await request(app).put('/api/marketplace/institute/payout-account').set(bearer(teacher)).send({}))
        .status,
    ).toBe(403);

    const run = await request(app).post('/api/admin/marketplace/payout-runs').set(bearer(admin)).send({});
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const apexSeller = (await MktSeller.findOne({ where: { slug: 'apex-coaching-classes' } }))!;
    const payout = run.body.items.find((p: { seller: { id: number } }) => p.seller.id === apexSeller.id);
    expect(payout.status).toBe('pending');
    const paid = await request(app)
      .post(`/api/admin/marketplace/payouts/${payout.id}/paid`)
      .set(bearer(admin))
      .send({ reference: 'ICIC52026112300077' });
    expect(paid.status).toBe(200);
    const apexAdminUser = (await User.findOne({ where: { mobile: USERS.apexAdmin.mobile } }))!;
    const notes = await NotificationMessage.findAll({
      where: { eventKey: 'marketplace.payout-paid', userId: apexAdminUser.id },
      tenantBypass: true,
    } as Parameters<typeof NotificationMessage.findAll>[0]);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].body).toContain('ICIC52026112300077');

    const runs = await request(app).get('/api/admin/marketplace/payout-runs').set(bearer(admin));
    expect(runs.body[0].id).toBe(run.body.id);
    await closeOpenRuns();
    expect(await MktPayout.count({ where: { runId: run.body.id, status: ['pending', 'held'] } })).toBe(0);
    expect(await MktPayoutAccount.count({ where: { sellerId: apexSeller.id } })).toBe(1);
  });
});
