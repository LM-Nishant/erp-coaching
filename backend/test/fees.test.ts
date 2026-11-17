import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PASSWORD, USERS, bearer, getApp, lastOtpFor, login, newDevice } from './helpers';
import { signMockWebhook, MOCK_SIGNATURE_HEADER } from '../src/infrastructure/payment-gateways/mock.gateway';
import { runWithContext } from '../src/shared/context';
import { hasCourseEntitlement } from '../src/modules/fees/api';
import { Op } from 'sequelize';
import { FeeLedgerEntry, FeePayment } from '../src/modules/fees/models';
import { releaseStaleCouponReservations } from '../src/modules/fees/payments.service';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { resolveCoursePrices } from '../src/modules/website/hooks';

let seq = 0;
const run = Date.now().toString(36).slice(-5).toUpperCase();
const mobile = () => `935${String(Date.now() % 10000).padStart(4, '0')}${String(seq++).padStart(3, '0')}`;
const WEBHOOK_SECRET = 'whsec_fees_test_secret';

async function otpLogin(m: string) {
  const app = await getApp();
  const device = newDevice();
  const ch = await request(app).post('/api/auth/otp/request').send({ mobile: m, device });
  const res = await request(app)
    .post('/api/auth/otp/verify')
    .send({ challengeId: ch.body.challengeId, code: lastOtpFor(m), device });
  expect(res.body.status).toBe('authenticated');
  return res.body.accessToken as string;
}

describe('fees, payments & accounting', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let accountant: string;
  let teacher: string;
  let zenith: string;
  let courseId: number;
  let structureId: number;
  let student: { id: number; userId: number; mobile: string };
  let accountId: number;
  let webhookPath: string;

  const trialBalance = async () => {
    const tb = await request(app).get('/api/fees/ledger/trial-balance').set(bearer(admin));
    expect(tb.status).toBe(200);
    return tb.body as { balanced: boolean; rows: { account: string; balance: number }[] };
  };
  const account = async (id = accountId) =>
    (await request(app).get(`/api/fees/accounts/${id}`).set(bearer(admin))).body;
  const newStudent = async (name: string) => {
    const m = mobile();
    const r = await request(app).post('/api/students').set(bearer(admin)).send({ name, mobile: m });
    expect(r.status).toBe(201);
    return { id: r.body.id as number, userId: r.body.userId as number, mobile: m };
  };

  beforeAll(async () => {
    app = await getApp();
    [admin, teacher, zenith] = await Promise.all(
      [USERS.apexAdmin, USERS.apexTeacher, USERS.zenithAdmin].map(async (u) => (await login(u)).accessToken),
    );
    // Dedicated accountant: the seeded one is reserved for auth.test device-limit assertions.
    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const accountantRole = roles.body.find((r: { slug: string }) => r.slug === 'accountant');
    const acct = { mobile: mobile(), password: DEMO_PASSWORD };
    const created = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({ name: 'Fees Accountant', ...acct, roles: [{ roleId: accountantRole.id, branchId: null }] });
    expect(created.status).toBe(201);
    accountant = (await login(acct)).accessToken;
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: `Fees JEE ${run}`, code: `FJ-${run}` });
    expect(course.status).toBe(201);
    courseId = course.body.id;
    student = await newStudent('Fee Payer');
    const gw = await request(app)
      .put('/api/fees/gateways/mock')
      .set(bearer(admin))
      .send({ enabled: true, isDefault: true, webhookSecret: WEBHOOK_SECRET });
    expect(gw.status).toBe(200);
    webhookPath = new URL(gw.body.webhookUrl).pathname;
    expect(webhookPath).toMatch(/^\/api\/fees\/public\/webhooks\/mock\//);
    expect(JSON.stringify(gw.body)).not.toContain(WEBHOOK_SECRET);
  });

  it('manages versioned fee structures with RBAC and tenant isolation', async () => {
    const body = {
      name: 'JEE Two-Year',
      courseId,
      instituteId: 2, // ignored: tenant comes from the token
      components: [
        { name: 'Tuition', amount: 9_000_000, taxable: true },
        { name: 'Material', amount: 1_000_000 },
      ],
      instalmentPlan: { type: 'quarterly', count: 4, firstDueDate: '2030-01-10' },
    };
    expect((await request(app).post('/api/fees/structures').set(bearer(teacher)).send(body)).status).toBe(
      403,
    );
    expect((await request(app).get('/api/fees/structures').set(bearer(teacher))).status).toBe(403);

    const v1 = await request(app).post('/api/fees/structures').set(bearer(admin)).send(body);
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ total: 10_000_000, version: 1, status: 'active' });

    const v2 = await request(app)
      .post(`/api/fees/structures/${v1.body.id}/versions`)
      .set(bearer(admin))
      .send({ components: [{ name: 'Tuition', amount: 12_000_000 }] });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, familyId: v1.body.id, total: 12_000_000 });
    const history = await request(app).get(`/api/fees/structures/${v2.body.id}`).set(bearer(admin));
    expect(
      history.body.versions.map((v: { version: number; status: string }) => [v.version, v.status]),
    ).toEqual([
      [2, 'active'],
      [1, 'archived'],
    ]);
    structureId = v2.body.id;

    expect((await request(app).get(`/api/fees/structures/${structureId}`).set(bearer(zenith))).status).toBe(
      404,
    );
    const zList = await request(app).get('/api/fees/structures?pageSize=100').set(bearer(zenith));
    expect(zList.body.items.some((s: { id: number }) => s.id === structureId)).toBe(false);
    expect(
      (await request(app).post(`/api/fees/structures/${structureId}/versions`).set(bearer(zenith)).send({}))
        .status,
    ).toBe(404);
  });

  it('generates a student fee account with instalments and a balanced charge journal', async () => {
    const r = await request(app)
      .post('/api/fees/accounts')
      .set(bearer(accountant))
      .send({ studentId: student.id, structureId, firstDueDate: '2030-01-10' });
    expect(r.status).toBe(201);
    accountId = r.body.id;
    expect(r.body).toMatchObject({ gross: 12_000_000, net: 12_000_000, balance: 12_000_000, paid: 0 });
    expect(r.body.instalments.map((i: { amount: number }) => i.amount)).toEqual([
      3_000_000, 3_000_000, 3_000_000, 3_000_000,
    ]);
    expect(r.body.instalments.map((i: { dueDate: string }) => i.dueDate)).toEqual([
      '2030-01-10',
      '2030-04-10',
      '2030-07-10',
      '2030-10-10',
    ]);
    expect((await trialBalance()).balanced).toBe(true);
    expect((await request(app).get(`/api/fees/accounts/${accountId}`).set(bearer(zenith))).status).toBe(404);
    expect((await request(app).get(`/api/fees/accounts/${accountId}`).set(bearer(teacher))).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/fees/accounts')
          .set(bearer(zenith))
          .send({ studentId: student.id, structureId })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('applies discounts, with maker-checker approval for accountants', async () => {
    const req1 = await request(app)
      .post(`/api/fees/accounts/${accountId}/adjustments`)
      .set(bearer(accountant))
      .send({ type: 'discount', mode: 'percent', value: 10, reason: 'Sibling' });
    expect(req1.status).toBe(201);
    expect(req1.body).toMatchObject({ status: 'pending', amount: 1_200_000 });
    expect((await account()).balance).toBe(12_000_000);
    expect(
      (await request(app).post(`/api/fees/adjustments/${req1.body.id}/approve`).set(bearer(accountant)))
        .status,
    ).toBe(403);
    const ok = await request(app).post(`/api/fees/adjustments/${req1.body.id}/approve`).set(bearer(admin));
    expect(ok.body.status).toBe('approved');
    const a = await account();
    expect(a).toMatchObject({ discount: 1_200_000, net: 10_800_000, balance: 10_800_000 });
    // Discount is taken from the latest instalments first.
    expect(a.instalments.map((i: { amount: number }) => i.amount)).toEqual([
      3_000_000, 3_000_000, 3_000_000, 1_800_000,
    ]);
    expect((await trialBalance()).balanced).toBe(true);
  });

  it('records offline payments idempotently with unique concurrent receipt numbers', async () => {
    const key = `offline-${run}-1`;
    const first = await request(app)
      .post('/api/fees/payments/offline')
      .set(bearer(accountant))
      .set('Idempotency-Key', key)
      .send({ accountId, amount: 500_000, mode: 'cash' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'successful', amount: 500_000 });
    expect(first.body.receiptNumber).toMatch(/RCPT/);
    const replay = await request(app)
      .post('/api/fees/payments/offline')
      .set(bearer(accountant))
      .set('Idempotency-Key', key)
      .send({ accountId, amount: 500_000, mode: 'cash' });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);

    const many = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app)
          .post('/api/fees/payments/offline')
          .set(bearer(accountant))
          .send({ accountId, amount: 100_000, mode: i % 2 ? 'upi' : 'cash', referenceNo: `UPI${i}` }),
      ),
    );
    expect(many.map((r) => r.status)).toEqual(Array(6).fill(201));
    const numbers = [first.body.receiptNumber, ...many.map((r) => r.body.receiptNumber)];
    expect(new Set(numbers).size).toBe(7);

    const a = await account();
    expect(a.paid).toBe(1_100_000);
    expect(a.balance).toBe(10_800_000 - 1_100_000);
    expect(a.instalments[0]).toMatchObject({ paid: 1_100_000, status: 'partial' });
    expect((await trialBalance()).balanced).toBe(true);

    const pdf = await request(app)
      .get(`/api/fees/receipts/${first.body.receiptId}/pdf`)
      .set(bearer(accountant));
    expect(pdf.status).toBe(200);
    expect(pdf.body.url).toBeTruthy();
    expect(
      (await request(app).get(`/api/fees/receipts/${first.body.receiptId}/pdf`).set(bearer(zenith))).status,
    ).toBe(404);
  });

  it('holds offline payments for approval when enabled', async () => {
    await request(app).put('/api/fees/settings').set(bearer(admin)).send({ offlineApprovalRequired: true });
    try {
      const p = await request(app)
        .post('/api/fees/payments/offline')
        .set(bearer(accountant))
        .send({ accountId, amount: 200_000, mode: 'cheque', chequeNumber: '000123', bankName: 'SBI' });
      expect(p.status).toBe(201);
      expect(p.body).toMatchObject({ status: 'pending', approvalStatus: 'pending', receiptNumber: null });
      const before = (await account()).paid;
      const approved = await request(app).post(`/api/fees/payments/${p.body.id}/approve`).set(bearer(admin));
      expect(approved.body).toMatchObject({ status: 'successful', approvalStatus: 'approved' });
      expect((await account()).paid).toBe(before + 200_000);

      const r = await request(app)
        .post('/api/fees/payments/offline')
        .set(bearer(accountant))
        .send({ accountId, amount: 50_000, mode: 'bank_transfer', referenceNo: 'NEFT1' });
      const rejected = await request(app)
        .post(`/api/fees/payments/${r.body.id}/reject`)
        .set(bearer(admin))
        .send({ reason: 'Not received' });
      expect(rejected.body.approvalStatus).toBe('rejected');
      expect((await account()).paid).toBe(before + 200_000);
    } finally {
      await request(app)
        .put('/api/fees/settings')
        .set(bearer(admin))
        .send({ offlineApprovalRequired: false });
    }
  });

  it('posts a signed gateway webhook exactly once however often it is delivered', async () => {
    const before = await account();
    const amount = before.instalments[0].balance as number;
    const checkout = await request(app)
      .post('/api/fees/payments/checkout')
      .set(bearer(accountant))
      .send({ accountId, amount, gateway: 'mock' });
    expect(checkout.status).toBe(201);
    const { paymentId, gatewayOrderId } = checkout.body;

    const body = JSON.stringify({
      event: 'payment.captured',
      eventId: `evt_${gatewayOrderId}`,
      gatewayOrderId,
      gatewayPaymentId: `pay_${gatewayOrderId}`,
      amountPaise: amount,
      feePaise: 2_000,
      status: 'success',
    });
    const sig = signMockWebhook(WEBHOOK_SECRET, body);
    const deliver = (b = body, s = sig) =>
      request(app)
        .post(webhookPath)
        .set('Content-Type', 'application/json')
        .set(MOCK_SIGNATURE_HEADER, s)
        .send(b);

    const forged = await deliver(body.replace(String(amount), String(amount + 1)), sig);
    expect(forged.status).toBe(401);
    expect((await deliver(body, 'deadbeef')).status).toBe(401);

    const results = await Promise.all(Array.from({ length: 5 }, () => deliver()));
    expect(results.map((r) => r.status)).toEqual(Array(5).fill(200));
    expect(results.filter((r) => r.body.outcome === 'posted')).toHaveLength(1);
    // Later redeliveries (including a re-sent event with a new id) are also no-ops.
    expect((await deliver()).body.outcome).toBe('duplicate');
    const resent = body.replace(`evt_${gatewayOrderId}`, `evt_${gatewayOrderId}_retry`);
    expect((await deliver(resent, signMockWebhook(WEBHOOK_SECRET, resent))).body.outcome).toBe(
      'already_processed',
    );

    const payment = await FeePayment.findOne({ where: { instituteId: 1, id: paymentId } });
    expect(payment).toMatchObject({ status: 'successful', gatewayCharge: 2_000 });
    const lines = await FeeLedgerEntry.findAll({
      where: { instituteId: 1, journalKey: `payment:${paymentId}` },
    });
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(amount);
    expect(lines.reduce((s, l) => s + l.credit, 0)).toBe(amount);
    const after = await account();
    expect(after.paid).toBe(before.paid + amount);
    expect(after.instalments[0].status).toBe('paid');
    expect((await trialBalance()).balanced).toBe(true);

    // Instalment 1 fully paid → course entitlement for LMS / exams.
    const entitled = await runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, () =>
      hasCourseEntitlement(student.userId, courseId),
    );
    expect(entitled).toBe(true);
    const zenithView = await runWithContext({ system: true, instituteId: 2, allowedBranchIds: null }, () =>
      hasCourseEntitlement(student.userId, courseId),
    );
    expect(zenithView).toBe(false);
  });

  it('lets a student see their fees and pay through the mock checkout', async () => {
    const token = await otpLogin(student.mobile);
    expect((await request(app).get('/api/fees/accounts').set(bearer(token))).status).toBe(403);
    const me = await request(app).get('/api/fees/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.accounts.map((a: { id: number }) => a.id)).toContain(accountId);
    expect(me.body.gateways).toContain('mock');
    const due = me.body.totalDue as number;

    const checkout = await request(app)
      .post('/api/fees/me/checkout')
      .set(bearer(token))
      .set('Idempotency-Key', `me-${run}`)
      .send({ accountId, amount: 300_000 });
    expect(checkout.status).toBe(201);
    const failed = await request(app)
      .post(`/api/fees/me/payments/${checkout.body.paymentId}/mock-complete`)
      .set(bearer(token))
      .send({ outcome: 'failed' });
    expect(failed.body.payment.status).toBe('failed');

    const retry = await request(app)
      .post('/api/fees/me/checkout')
      .set(bearer(token))
      .send({ accountId, amount: 300_000 });
    const done = await request(app)
      .post(`/api/fees/me/payments/${retry.body.paymentId}/mock-complete`)
      .set(bearer(token))
      .send({ outcome: 'success' });
    expect(done.body.payment.status).toBe('successful');
    const again = await request(app)
      .post(`/api/fees/me/payments/${retry.body.paymentId}/mock-complete`)
      .set(bearer(token))
      .send({ outcome: 'success' });
    expect(['duplicate', 'already_processed']).toContain(again.body.outcome);
    expect((await request(app).get('/api/fees/me').set(bearer(token))).body.totalDue).toBe(due - 300_000);

    const rc = await request(app)
      .get(`/api/fees/me/receipts/${done.body.payment.receiptId}/pdf`)
      .set(bearer(token));
    expect(rc.status).toBe(200);
    const share = await request(app)
      .post(`/api/fees/me/receipts/${done.body.payment.receiptId}/share`)
      .set(bearer(token));
    expect(share.body.shared).toBe(true);

    // Another student's account and receipts stay hidden.
    const other = await newStudent('Other Payer');
    const acc2 = await request(app)
      .post('/api/fees/accounts')
      .set(bearer(admin))
      .send({ studentId: other.id, structureId });
    expect(
      (await request(app).post('/api/fees/me/checkout').set(bearer(token)).send({ accountId: acc2.body.id }))
        .status,
    ).toBe(404);
    expect((await trialBalance()).balanced).toBe(true);
  });

  it('refunds and cancels payments with reversing journals', async () => {
    const pay = await request(app)
      .post('/api/fees/payments/offline')
      .set(bearer(accountant))
      .send({ accountId, amount: 400_000, mode: 'cash' });
    const paidBefore = (await account()).paid;
    expect(
      (await request(app).post(`/api/fees/payments/${pay.body.id}/refund`).set(bearer(accountant)).send({}))
        .status,
    ).toBe(403);
    const key = `refund-${run}`;
    const refund = await request(app)
      .post(`/api/fees/payments/${pay.body.id}/refund`)
      .set(bearer(admin))
      .set('Idempotency-Key', key)
      .send({ amount: 150_000, reason: 'Overpaid' });
    expect(refund.status).toBe(201);
    expect(refund.body.payment).toMatchObject({ refunded: 150_000, status: 'partially_refunded' });
    const replay = await request(app)
      .post(`/api/fees/payments/${pay.body.id}/refund`)
      .set(bearer(admin))
      .set('Idempotency-Key', key)
      .send({ amount: 150_000 });
    expect(replay.status).toBe(200);
    expect(replay.body.payment.refunded).toBe(150_000);
    expect((await account()).paid).toBe(paidBefore - 150_000);
    expect(
      (
        await request(app)
          .post(`/api/fees/payments/${pay.body.id}/refund`)
          .set(bearer(admin))
          .send({ amount: 300_000 })
      ).status,
    ).toBe(400);

    const cash = await request(app)
      .post('/api/fees/payments/offline')
      .set(bearer(accountant))
      .send({ accountId, amount: 70_000, mode: 'cash' });
    const cancelled = await request(app)
      .post(`/api/fees/payments/${cash.body.id}/cancel`)
      .set(bearer(admin))
      .send({ reason: 'Wrong student' });
    expect(cancelled.body.status).toBe('cancelled');
    expect((await account()).paid).toBe(paidBefore - 150_000);
    expect((await trialBalance()).balanced).toBe(true);
  });

  it('runs due reminders, overdue notices and late fees idempotently', async () => {
    await request(app)
      .put('/api/fees/settings')
      .set(bearer(admin))
      .send({ lateFee: { type: 'fixed', amount: 25_000, graceDays: 0 } });
    try {
      const s = await newStudent('Late Payer');
      const acc = await request(app)
        .post('/api/fees/accounts')
        .set(bearer(admin))
        .send({ studentId: s.id, structureId, firstDueDate: '2020-01-10' });
      const r1 = await request(app)
        .post('/api/fees/jobs/sweep')
        .set(bearer(admin))
        .send({ asOf: '2020-02-01' });
      expect(r1.status).toBe(200);
      expect(r1.body.lateFees).toBeGreaterThanOrEqual(1);
      await request(app).post('/api/fees/jobs/sweep').set(bearer(admin)).send({ asOf: '2020-02-01' });
      const a = await account(acc.body.id);
      expect(a.lateFee).toBe(25_000);
      expect(a.instalments[0]).toMatchObject({ lateFee: 25_000, overdue: true });
      expect(a.balance).toBe(12_000_000 + 25_000);
      expect((await trialBalance()).balanced).toBe(true);
    } finally {
      await request(app)
        .put('/api/fees/settings')
        .set(bearer(admin))
        .send({ lateFee: { type: 'none' } });
    }
  });

  it('creates a fee account automatically when an admission completes', async () => {
    const application = await request(app)
      .post('/api/admissions/applications')
      .set(bearer(admin))
      .send({ name: 'Auto Account', mobile: mobile(), courseId });
    expect(application.status).toBe(201);
    const admitted = await request(app)
      .post(`/api/admissions/applications/${application.body.id}/admit`)
      .set(bearer(admin))
      .send({});
    expect(admitted.status).toBe(201);
    await processDueJobs();
    const list = await request(app)
      .get(`/api/fees/accounts?studentId=${admitted.body.student.id}`)
      .set(bearer(admin));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ source: 'admission', structureId, net: 12_000_000 });
    await processDueJobs(); // re-delivery stays a no-op
    expect(
      (await request(app).get(`/api/fees/accounts?studentId=${admitted.body.student.id}`).set(bearer(admin)))
        .body.items,
    ).toHaveLength(1);
  });

  it('issues GST tax invoices with CGST/SGST from inclusive fees', async () => {
    await request(app)
      .put('/api/fees/settings')
      .set(bearer(admin))
      .send({ gstEnabled: true, gstRatePercent: 18, gstin: '27ABCDE1234F1Z5' });
    try {
      const st = await request(app)
        .post('/api/fees/structures')
        .set(bearer(admin))
        .send({
          name: `GST course ${run}`,
          courseId,
          components: [
            { name: 'Coaching', amount: 1_180_000, taxable: true },
            { name: 'Exam fee', amount: 20_000, taxable: false },
          ],
          instalmentPlan: { type: 'one_time' },
        });
      expect(st.status).toBe(201);
      const s = await newStudent('GST Payer');
      const acc = await request(app)
        .post('/api/fees/accounts')
        .set(bearer(admin))
        .send({ studentId: s.id, structureId: st.body.id });
      const pay = await request(app)
        .post('/api/fees/payments/offline')
        .set(bearer(accountant))
        .send({ accountId: acc.body.id, amount: 1_200_000, mode: 'upi', referenceNo: 'GSTUPI' });
      const rc = await request(app).get(`/api/fees/receipts/${pay.body.receiptId}`).set(bearer(accountant));
      expect(rc.body).toMatchObject({ taxableValue: 1_000_000, cgst: 90_000, sgst: 90_000, igst: 0 });
      expect(rc.body.invoiceNumber).toMatch(/INV/);
      const tb = await trialBalance();
      expect(tb.balanced).toBe(true);
      expect(tb.rows.find((r) => r.account === 'gst_payable')!.balance).toBeLessThanOrEqual(-180_000);
    } finally {
      await request(app).put('/api/fees/settings').set(bearer(admin)).send({ gstEnabled: false });
    }
  });

  it('records expenses and reports P&L, daily cash, collections and dues with exports', async () => {
    const cat = await request(app)
      .post('/api/fees/finance/categories')
      .set(bearer(accountant))
      .send({ kind: 'expense', name: `Rent ${run}` });
    expect(cat.status).toBe(201);
    const exp = await request(app)
      .post('/api/fees/finance/entries')
      .set(bearer(accountant))
      .send({ kind: 'expense', categoryId: cat.body.id, amount: 300_000, mode: 'cash', party: 'Landlord' });
    expect(exp.status).toBe(201);
    expect((await request(app).get('/api/fees/finance/entries').set(bearer(teacher))).status).toBe(403);
    expect((await request(app).get('/api/fees/finance/entries').set(bearer(zenith))).body.items).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ id: exp.body.id })]),
    );

    const t = new Date().toISOString().slice(0, 10);
    const pnl = await request(app).get(`/api/fees/reports/pnl?from=${t}&to=${t}`).set(bearer(admin));
    expect(pnl.status).toBe(200);
    expect(pnl.body.net).toBe(pnl.body.totalIncome - pnl.body.totalExpenditure);
    expect(pnl.body.expenditure.some((x: { amount: number }) => x.amount >= 300_000)).toBe(true);

    const cashRep = await request(app).get(`/api/fees/reports/daily-cash?date=${t}`).set(bearer(accountant));
    expect(cashRep.status).toBe(200);
    expect(cashRep.body.closing).toBe(cashRep.body.opening + cashRep.body.cashIn - cashRep.body.cashOut);

    const coll = await request(app)
      .get(`/api/fees/reports/collections?from=${t}&to=${t}&format=csv`)
      .set(bearer(accountant));
    expect(coll.status).toBe(200);
    expect(coll.headers['content-type']).toMatch(/text\/csv/);
    expect(coll.text.split('\n')[0]).toContain('Receipt');
    const dues = await request(app).get('/api/fees/reports/outstanding?format=xls').set(bearer(accountant));
    expect(dues.headers['content-type']).toMatch(/ms-excel/);
    const duesJson = await request(app).get('/api/fees/reports/outstanding').set(bearer(accountant));
    expect(duesJson.body.items.some((x: { accountId: number }) => x.accountId === accountId)).toBe(true);
    const zDues = await request(app).get('/api/fees/reports/outstanding').set(bearer(zenith));
    expect(zDues.body.items.some((x: { accountId: number }) => x.accountId === accountId)).toBe(false);

    expect((await trialBalance()).balanced).toBe(true);
  });
});

describe('fees ↔ LMS / website: paid course purchase with coupon and referral', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let courseId: number;
  let resourceId: number;
  let couponId: number;
  let webhookPath: string;
  const couponCode = `PAID${run}`;
  const refCode = `PREF${run}`;

  beforeAll(async () => {
    app = await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    const gw = await request(app)
      .put('/api/fees/gateways/mock')
      .set(bearer(admin))
      .send({ enabled: true, isDefault: true, webhookSecret: WEBHOOK_SECRET });
    webhookPath = new URL(gw.body.webhookUrl).pathname;
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: `Paid Course ${run}`, code: `PC-${run}` });
    courseId = course.body.id;
    const res = await request(app).post('/api/lms/resources').set(bearer(admin)).send({
      courseId,
      title: 'Paid lesson',
      type: 'link',
      externalUrl: 'https://example.com/paid',
      access: 'paid',
    });
    expect(res.status).toBe(201);
    resourceId = res.body.id;
    await request(app).post(`/api/lms/resources/${resourceId}/publish`).set(bearer(admin));
    // A free taster puts the course in every learner's library, with the paid lesson locked.
    const taster = await request(app).post('/api/lms/resources').set(bearer(admin)).send({
      courseId,
      title: 'Free taster',
      type: 'link',
      externalUrl: 'https://example.com/free',
      access: 'free',
    });
    await request(app).post(`/api/lms/resources/${taster.body.id}/publish`).set(bearer(admin));
    const coupon = await request(app)
      .post('/api/website/coupons')
      .set(bearer(admin))
      .send({ code: couponCode, discountType: 'fixed', discountValue: 1_000, usageLimit: 5 });
    expect(coupon.status).toBe(201);
    couponId = coupon.body.id;
    expect(
      (
        await request(app)
          .post('/api/website/referrals')
          .set(bearer(admin))
          .send({ code: refCode, name: 'Partner' })
      ).status,
    ).toBe(201);
  });

  it('prices and hands off checkout only once the course has an active fee structure', async () => {
    const sys = { system: true, instituteId: 1, allowedBranchIds: null };
    expect((await runWithContext(sys, () => resolveCoursePrices([courseId]))).get(courseId)).toBeUndefined();
    const free = await request(app).get(`/api/public/sites/apex/checkout/${courseId}?format=json`);
    expect(free.body.handler).toBe('admission');

    const st = await request(app)
      .post('/api/fees/structures')
      .set(bearer(admin))
      .send({
        name: `Paid ${run}`,
        courseId,
        components: [{ name: 'Course fee', amount: 1_000_000 }],
        instalmentPlan: { type: 'one_time', count: 1, firstDueDate: '2030-01-10' },
      });
    expect(st.status).toBe(201);
    expect((await runWithContext(sys, () => resolveCoursePrices([courseId]))).get(courseId)).toBe('₹10,000');
    const paid = await request(app).get(
      `/api/public/sites/apex/checkout/${courseId}?format=json&coupon=${couponCode.toLowerCase()}&ref=${refCode}`,
    );
    expect(paid.body.handler).toBe('fees');
    const url = new URL(paid.body.url);
    expect(url.pathname).toBe(`/my-fees/buy/${courseId}`);
    expect(url.searchParams.get('coupon')).toBe(couponCode);
    expect(url.searchParams.get('ref')).toBe(refCode);
  });

  it('locks LMS content until the payment is captured, redeems the coupon once and releases it on refund', async () => {
    const m = mobile();
    const created = await request(app)
      .post('/api/students')
      .set(bearer(admin))
      .send({ name: 'Buyer', mobile: m });
    expect(created.status).toBe(201);
    const token = await otpLogin(m);
    const lessonLocked = async () => {
      const c = await request(app).get(`/api/lms/courses/${courseId}/contents`).set(bearer(token));
      expect(c.status).toBe(200);
      return c.body.resources.find((r: { id: number }) => r.id === resourceId).locked as boolean;
    };
    expect(await lessonLocked()).toBe(true);
    expect((await request(app).post(`/api/lms/resources/${resourceId}/play`).set(bearer(token))).status).toBe(
      403,
    );

    const quote = await request(app)
      .get(`/api/fees/me/courses/${courseId}/quote`)
      .query({ coupon: couponCode })
      .set(bearer(token));
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({
      amount: 1_000_000,
      discount: 100_000,
      payable: 900_000,
      alreadyPaid: false,
    });
    expect(quote.body.coupon).toMatchObject({ code: couponCode, valid: true });

    const checkout = await request(app)
      .post(`/api/fees/me/courses/${courseId}/checkout`)
      .set(bearer(token))
      .set('Idempotency-Key', `buy-${run}`)
      .send({ couponCode, referralCode: refCode });
    expect(checkout.status).toBe(201);
    expect(checkout.body).toMatchObject({ amount: 900_000, discount: 100_000, couponCode, gateway: 'mock' });
    const { paymentId, gatewayOrderId } = checkout.body;
    expect(await lessonLocked()).toBe(true);

    const body = JSON.stringify({
      event: 'payment.captured',
      eventId: `evt_${gatewayOrderId}`,
      gatewayOrderId,
      gatewayPaymentId: `pay_${gatewayOrderId}`,
      amountPaise: 900_000,
      status: 'success',
    });
    const deliver = (b = body) =>
      request(app)
        .post(webhookPath)
        .set('Content-Type', 'application/json')
        .set(MOCK_SIGNATURE_HEADER, signMockWebhook(WEBHOOK_SECRET, b))
        .send(b);
    expect((await deliver()).body.outcome).toBe('posted');
    expect((await deliver()).body.outcome).toBe('duplicate');
    const resent = body.replace(`evt_${gatewayOrderId}`, `evt_${gatewayOrderId}_retry`);
    expect((await deliver(resent)).body.outcome).toBe('already_processed');

    expect(await lessonLocked()).toBe(false);
    expect((await request(app).post(`/api/lms/resources/${resourceId}/play`).set(bearer(token))).status).toBe(
      200,
    );
    const lines = await FeeLedgerEntry.findAll({
      where: { instituteId: 1, journalKey: `payment:${paymentId}` },
    });
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(900_000);
    const couponLines = await FeeLedgerEntry.findAll({
      where: { instituteId: 1, journalKey: { [Op.like]: `payment-coupon:${paymentId}:%` } },
    });
    expect(couponLines.reduce((s, l) => s + l.debit, 0)).toBe(100_000);
    const coupon = async () =>
      (await request(app).get(`/api/website/coupons/${couponId}`).set(bearer(admin))).body;
    expect((await coupon()).usedCount).toBe(1);
    const refs = await request(app)
      .get('/api/website/referrals')
      .set(bearer(admin))
      .query({ search: refCode });
    expect(refs.body.items[0].purchases).toBe(1);
    const again = await request(app).get(`/api/fees/me/courses/${courseId}/quote`).set(bearer(token));
    expect(again.body.alreadyPaid).toBe(true);
    const feeAccount = async () =>
      (await request(app).get(`/api/fees/accounts/${again.body.accountId}`).set(bearer(admin))).body;
    expect(await feeAccount()).toMatchObject({ discount: 100_000, paid: 900_000 });
    const tb = await request(app).get('/api/fees/ledger/trial-balance').set(bearer(admin));
    expect(tb.body.balanced).toBe(true);

    const refund = await request(app)
      .post(`/api/fees/payments/${paymentId}/refund`)
      .set(bearer(admin))
      .send({ amount: 900_000, reason: 'Changed mind' });
    expect(refund.status).toBe(201);
    expect((await coupon()).usedCount).toBe(0);
    const reds = await request(app).get(`/api/website/coupons/${couponId}/redemptions`).set(bearer(admin));
    expect(reds.body.items.map((x: { status: string }) => x.status)).toEqual(['released']);
    expect(await lessonLocked()).toBe(true);
    // The coupon discount is undone too: full price is due again and the ledger stays balanced.
    const restored = await feeAccount();
    expect(restored).toMatchObject({ discount: 0, paid: 0 });
    expect(restored.instalments[0]).toMatchObject({ amount: 1_000_000, paid: 0 });
    expect((await request(app).get('/api/fees/ledger/trial-balance').set(bearer(admin))).body.balanced).toBe(
      true,
    );
  });

  it('gives a per-customer coupon discount once across concurrent checkouts and expires reservations', async () => {
    const code = `ONCE${run}`;
    const c = await request(app)
      .post('/api/website/coupons')
      .set(bearer(admin))
      .send({ code, discountType: 'fixed', discountValue: 1_000, perCustomerLimit: 1 });
    expect(c.status).toBe(201);
    const usedCount = async () =>
      (await request(app).get(`/api/website/coupons/${c.body.id}`).set(bearer(admin))).body.usedCount;
    const buyer = async (name: string) => {
      const m = mobile();
      expect(
        (await request(app).post('/api/students').set(bearer(admin)).send({ name, mobile: m })).status,
      ).toBe(201);
      return otpLogin(m);
    };
    const pay = (token: string, id: number) =>
      request(app)
        .post(`/api/fees/me/payments/${id}/mock-complete`)
        .set(bearer(token))
        .send({ outcome: 'success' });

    const token = await buyer('Coupon Stacker');
    const first = await request(app)
      .post(`/api/fees/me/courses/${courseId}/checkout`)
      .set(bearer(token))
      .send({ couponCode: code });
    expect(first.body).toMatchObject({ amount: 900_000, discount: 100_000 });
    expect(await usedCount()).toBe(1); // reserved while the order is open
    const accountId = (await request(app).get(`/api/fees/me/courses/${courseId}/quote`).set(bearer(token)))
      .body.accountId as number;
    const second = await request(app)
      .post('/api/fees/me/checkout')
      .set(bearer(token))
      .send({ accountId, amount: 300_000, couponCode: code });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ amount: 200_000, discount: 100_000 });
    expect(await usedCount()).toBe(1); // the second checkout took over the reservation

    expect((await pay(token, first.body.paymentId)).body.payment).toMatchObject({
      status: 'successful',
      couponDiscount: 0, // its reservation was superseded and the customer limit is used up
    });
    expect((await pay(token, second.body.paymentId)).body.payment).toMatchObject({
      status: 'successful',
      couponDiscount: 100_000,
    });
    const acc = (await request(app).get(`/api/fees/accounts/${accountId}`).set(bearer(admin))).body;
    expect(acc).toMatchObject({ discount: 100_000, paid: 900_000, advance: 200_000 });
    expect(await usedCount()).toBe(1);
    const tb = await request(app).get('/api/fees/ledger/trial-balance').set(bearer(admin));
    expect(tb.body.balanced).toBe(true);

    // An abandoned checkout gives its reservation back; a late capture re-redeems if still allowed.
    const late = await buyer('Late Payer');
    const open = await request(app)
      .post(`/api/fees/me/courses/${courseId}/checkout`)
      .set(bearer(late))
      .send({ couponCode: code });
    expect(open.status).toBe(201);
    expect(await usedCount()).toBe(2);
    const released = await runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, () =>
      releaseStaleCouponReservations(new Date(Date.now() + 25 * 3_600_000)),
    );
    expect(released).toBeGreaterThanOrEqual(1);
    expect(await usedCount()).toBe(1);
    expect((await pay(late, open.body.paymentId)).body.payment.couponDiscount).toBe(100_000);
    expect(await usedCount()).toBe(2);
  });
});
