import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import type { SaasInvoiceDto } from '@erp/shared';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { MOCK_SIGNATURE_HEADER, signMockWebhook } from '../src/infrastructure/payment-gateways/mock.gateway';
import { runWithContext } from '../src/shared/context';
import {
  invalidateAccess,
  revenueByMonth,
  subscriptionsByPlan,
  usageSummary,
} from '../src/modules/subscriptions/api';
import {
  DEFAULT_BILLING_POLICY,
  clearBillingSettingsCache,
  getBillingPolicy,
} from '../src/modules/subscriptions/billing-settings';
import { computeAccessState } from '../src/modules/subscriptions/subscription.service';
import type { Subscription } from '../src/modules/subscriptions/models';
import { sweepInstitute, type BillingSweepResult } from '../src/modules/subscriptions/sweep.service';
import { billingDate } from '../src/modules/subscriptions/util';
import { bearer, getApp, login, purgeRows, USERS } from './helpers';

const DAY = 86_400_000;
const RUN = Date.now().toString(36);
const STARTED_AT = new Date(Date.now() - 1000);
/** Raw-query replacements format Dates in the process's local zone; the DB stores UTC. */
const utc = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const PASSWORD = 'Password@123';
/** 9421… is this suite's mobile range. */
const mobile = () => `9421${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
const WEBHOOK = '/api/subscriptions/public/webhooks/mock';
const SETTING_KEYS = ['billing.profile', 'billing.policy'];

const PROFILE = {
  legalName: 'Billing Test Cloud Pvt Ltd',
  gstin: '29ABCDE1234F1Z5',
  address: '1 Test Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
  email: 'billing@test.local',
  phone: '08000000000',
  invoicePrefix: 'TST',
  creditNotePrefix: 'TCN',
  sacCode: '998315',
  gstRatePercent: 18,
};

const limits = (o: Record<string, unknown> = {}) => ({
  maxStudents: 50,
  maxBranches: 2,
  maxTeachers: 10,
  storageMb: 1024,
  aiTokensMonthly: 100_000,
  enabledModules: null,
  ...o,
});
const ADDONS = [
  { kind: 'students', unitSize: 10, monthlyPricePaise: 20_000 },
  { kind: 'ai_credits', unitSize: 50_000, monthlyPricePaise: 30_000 },
];

interface Tenant {
  id: number;
  slug: string;
  token: string;
}

let sa: string;
let savedSettings: Record<string, unknown>[] = [];
const planIds: Record<'basic' | 'pro' | 'tiny' | 'metered', number> = {
  basic: 0,
  pro: 0,
  tiny: 0,
  metered: 0,
};
let A: Tenant;
let B: Tenant;

async function createPlan(body: Record<string, unknown>): Promise<number> {
  const res = await request(await getApp())
    .post('/api/admin/plans')
    .set(bearer(sa))
    .send(body);
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function createInstitute(key: string, planId: number, state: string): Promise<Tenant> {
  const slug = `bt-${key}-${RUN}`;
  const adminMobile = mobile();
  const res = await request(await getApp())
    .post('/api/admin/institutes')
    .set(bearer(sa))
    .send({
      name: `Billing Test ${key.toUpperCase()}`,
      slug,
      planId,
      state,
      admin: { name: `Billing Admin ${key}`, mobile: adminMobile, password: PASSWORD },
    });
  expect(res.status).toBe(201);
  const { accessToken } = await login({ mobile: adminMobile, password: PASSWORD });
  return { id: res.body.id, slug, token: accessToken };
}

async function overview(t: Tenant) {
  const res = await request(await getApp())
    .get('/api/subscription/overview')
    .set(bearer(t.token));
  expect(res.status).toBe(200);
  return res.body;
}

/** Pays an invoice through the mock gateway (checkout + simulated webhook). */
async function payOnline(t: Tenant, invoice: SaasInvoiceDto, key = `pay-${invoice.id}-${RUN}`) {
  const app = await getApp();
  const checkout = await request(app)
    .post(`/api/subscription/invoices/${invoice.id}/checkout`)
    .set(bearer(t.token))
    .set('Idempotency-Key', key);
  expect(checkout.status).toBe(201);
  const done = await request(app)
    .post(`/api/subscription/payments/${checkout.body.payment.id}/mock-complete`)
    .set(bearer(t.token))
    .send({ outcome: 'success' });
  expect(done.status).toBe(200);
  expect(done.body.outcome).toBe('paid');
  return checkout.body.payment as { id: number; gatewayOrderId: string; amountPaise: number };
}

async function setEndsAt(t: Tenant, endsAt: Date) {
  await getSequelize().query('UPDATE subscriptions SET ends_at = ? WHERE institute_id = ?', {
    replacements: [utc(endsAt), t.id],
  });
  invalidateAccess(t.id);
}

function postWebhook(body: Record<string, unknown>, secret = 'mock-webhook-secret') {
  return getApp().then((app) => {
    const raw = JSON.stringify(body);
    return request(app)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signMockWebhook(secret, raw))
      .send(raw);
  });
}

beforeAll(async () => {
  const app = await getApp();
  sa = (await login(USERS.superAdmin)).accessToken;
  savedSettings = await getSequelize().query(
    'SELECT id, `key`, value, updated_by, created_at, updated_at FROM subscription_settings WHERE `key` IN (?)',
    { replacements: [SETTING_KEYS], type: QueryTypes.SELECT },
  );
  expect(
    (await request(app).put('/api/admin/billing/settings/profile').set(bearer(sa)).send(PROFILE)).status,
  ).toBe(200);
  expect(
    (
      await request(app)
        .put('/api/admin/billing/settings/policy')
        .set(bearer(sa))
        .send({ ...DEFAULT_BILLING_POLICY })
    ).status,
  ).toBe(200);

  planIds.basic = await createPlan({
    code: `bt-basic-${RUN}`,
    name: 'BT Basic',
    priceMonthlyPaise: 100_000,
    priceYearlyPaise: 1_000_000,
    trialDays: 14,
    limits: limits(),
    addons: ADDONS,
  });
  planIds.pro = await createPlan({
    code: `bt-pro-${RUN}`,
    name: 'BT Pro',
    priceMonthlyPaise: 300_000,
    priceYearlyPaise: 3_000_000,
    trialDays: 14,
    limits: limits({ maxStudents: 200, maxBranches: 5 }),
    addons: ADDONS,
  });
  planIds.tiny = await createPlan({
    code: `bt-tiny-${RUN}`,
    name: 'BT Tiny',
    priceMonthlyPaise: 50_000,
    priceYearlyPaise: 500_000,
    trialDays: 14,
    limits: limits({ maxBranches: 0 }),
  });
  planIds.metered = await createPlan({
    code: `bt-metered-${RUN}`,
    name: 'BT Metered',
    priceMonthlyPaise: 200_000,
    priceYearlyPaise: 2_000_000,
    trialDays: 0,
    limits: limits({ maxBranches: 1 }),
    usagePricing: { branches: { unitSize: 1, pricePaise: 50_000, maxOverage: 2 } },
  });
  A = await createInstitute('a', planIds.basic, 'Karnataka');
  B = await createInstitute('b', planIds.metered, 'Maharashtra');
});

afterAll(async () => {
  const sequelize = getSequelize();
  const ids = [A?.id, B?.id].filter((id): id is number => !!id);
  const select = async (sql: string, replacements: unknown[]) =>
    (await sequelize.query<{ id: number }>(sql, { replacements, type: QueryTypes.SELECT })).map((r) => r.id);
  if (ids.length) {
    const payments = await select('SELECT id FROM subscription_payments WHERE institute_id IN (?)', [ids]);
    if (payments.length)
      await sequelize.query('DELETE FROM subscription_webhook_events WHERE payment_id IN (?)', {
        replacements: [payments],
      });
    // Billing documents are kept when an institute is deleted (institute_id → NULL), so remove them first.
    await sequelize.query('DELETE FROM subscription_payments WHERE institute_id IN (?)', {
      replacements: [ids],
    });
    await sequelize.query('DELETE FROM subscription_credit_notes WHERE institute_id IN (?)', {
      replacements: [ids],
    });
    await purgeRows(
      'subscription_invoices',
      await select('SELECT id FROM subscription_invoices WHERE institute_id IN (?)', [ids]),
    );
    await sequelize.query('DELETE FROM audit_events WHERE institute_id IN (?)', { replacements: [ids] });
    await purgeRows('institutes', ids);
  }
  await sequelize.query('DELETE FROM subscription_webhook_events WHERE event_key LIKE ?', {
    replacements: [`bt-${RUN}-%`],
  });
  // Platform-level audit rows of this suite (plans and billing settings).
  await sequelize.query(
    "DELETE FROM audit_events WHERE institute_id IS NULL AND created_at >= ? AND entity_type IN ('plan', 'billing_settings')",
    { replacements: [utc(STARTED_AT)] },
  );
  await purgeRows('users', await select("SELECT id FROM users WHERE mobile LIKE '9421%'", []));
  await purgeRows('plans', Object.values(planIds));
  await sequelize.query(
    "DELETE FROM subscription_sequences WHERE scope_key LIKE 'TST/%' OR scope_key LIKE 'TCN/%'",
  );
  await sequelize.query('DELETE FROM subscription_settings WHERE `key` IN (?)', {
    replacements: [SETTING_KEYS],
  });
  for (const row of savedSettings)
    await sequelize.query(
      'INSERT INTO subscription_settings (id, `key`, value, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      {
        replacements: [
          row.id,
          row.key,
          typeof row.value === 'string' ? row.value : JSON.stringify(row.value),
          row.updated_by,
          utc(row.created_at as Date),
          utc(row.updated_at as Date),
        ],
      },
    );
  clearBillingSettingsCache();
  invalidateAccess();
});

describe('access state', () => {
  const sub = (status: string, endsAt: Date | null, suspendedAt: Date | null = null) =>
    ({ status, endsAt, suspendedAt }) as unknown as Subscription;
  const now = new Date('2026-06-15T10:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const policy = { ...DEFAULT_BILLING_POLICY };

  it('moves from grace to restricted to suspended after the period ends', () => {
    expect(computeAccessState(sub('active', new Date(now.getTime() + DAY)), policy, now).state).toBe(
      'active',
    );
    expect(computeAccessState(sub('active', null), policy, now).state).toBe('active');
    expect(computeAccessState(sub('active', ago(1)), policy, now).state).toBe('grace');
    expect(computeAccessState(sub('active', ago(8)), policy, now).state).toBe('restricted');
    expect(computeAccessState(sub('active', ago(38)), policy, now).state).toBe('suspended');
    // Trials use the shorter trial grace.
    expect(computeAccessState(sub('trial', ago(2)), policy, now).state).toBe('grace');
    expect(computeAccessState(sub('trial', ago(4)), policy, now).state).toBe('restricted');
    // A manual suspension wins, also over an open-ended plan.
    expect(computeAccessState(sub('active', null, ago(1)), policy, now).state).toBe('suspended');
  });

  it('follows the policy for what happens after grace', () => {
    const strict = { ...policy, afterGrace: 'suspended' as const };
    expect(computeAccessState(sub('active', ago(8)), strict, now).state).toBe('suspended');
    const lenient = { ...policy, suspendAfterDays: null };
    const info = computeAccessState(sub('active', ago(400)), lenient, now);
    expect(info.state).toBe('restricted');
    expect(info.suspendsAt).toBeNull();
  });
});

describe('SaaS billing', () => {
  it('shows a new institute its trial, limits, usage and AI quota', async () => {
    const app = await getApp();
    const status = await request(app).get('/api/subscription/status').set(bearer(A.token));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ state: 'trial', planName: 'BT Basic', canManage: true });
    expect(status.body.daysLeft).toBeGreaterThanOrEqual(13);

    const o = await overview(A);
    expect(o.selfService).toBe(true);
    expect(o.limits).toMatchObject({ maxStudents: 50, maxBranches: 2, aiTokensMonthly: 100_000 });
    expect(o.usage.find((u: { metric: string }) => u.metric === 'branches')).toMatchObject({
      used: 1,
      included: 2,
      remaining: 1,
    });
    expect(o.ai).toMatchObject({ includedThisMonth: 100_000, creditsThisMonth: 0, remaining: 100_000 });
    expect(o.addonCatalogue.map((a: { kind: string }) => a.kind).sort()).toEqual(['ai_credits', 'students']);
    expect(o.gstRatePercent).toBe(18);

    // Open-ended (platform managed) subscriptions have no self-service billing.
    const b = await overview(B);
    expect(b.status.state).toBe('active');
    expect(b.selfService).toBe(false);
    const renew = await request(app).post('/api/subscription/renew').set(bearer(B.token));
    expect(renew.status).toBe(409);
    expect(renew.body.error.code).toBe('PLAN_MANAGED');
  });

  it('lets the super admin extend a trial', async () => {
    const app = await getApp();
    const before = (await overview(A)).subscription.endsAt;
    const res = await request(app)
      .post(`/api/admin/billing/institutes/${A.id}/extend-trial`)
      .set(bearer(sa))
      .send({ days: 5 });
    expect(res.status).toBe(200);
    expect(new Date(res.body.endsAt).getTime() - new Date(before).getTime()).toBe(5 * DAY);
    expect(res.body.trialExtendedDays).toBe(5);

    const notTrial = await request(app)
      .post(`/api/admin/billing/institutes/${B.id}/extend-trial`)
      .set(bearer(sa))
      .send({ days: 5 });
    expect(notTrial.status).toBe(409);
    expect(notTrial.body.error.code).toBe('NOT_TRIAL');
  });

  it('switches plans for free during the trial and refuses recurring add-ons', async () => {
    const app = await getApp();
    const preview = await request(app)
      .post('/api/subscription/plan-change/preview')
      .set(bearer(A.token))
      .send({ planId: planIds.pro, billingCycle: 'monthly' });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ kind: 'trial', totalPaise: 0 });

    for (const planId of [planIds.pro, planIds.basic]) {
      const res = await request(app)
        .post('/api/subscription/plan-change')
        .set(bearer(A.token))
        .send({ planId, billingCycle: 'monthly' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: true, invoice: null });
    }
    expect((await overview(A)).plan.id).toBe(planIds.basic);

    const same = await request(app)
      .post('/api/subscription/plan-change')
      .set(bearer(A.token))
      .send({ planId: planIds.basic, billingCycle: 'monthly' });
    expect(same.status).toBe(400);

    const addon = await request(app)
      .post('/api/subscription/addons')
      .set(bearer(A.token))
      .send({ kind: 'students', quantity: 1 });
    expect(addon.status).toBe(409);
    expect(addon.body.error.code).toBe('TRIAL_ADDON');
    const notOffered = await request(app)
      .post('/api/subscription/addons')
      .set(bearer(A.token))
      .send({ kind: 'branches', quantity: 1 });
    expect(notOffered.status).toBe(400);
  });

  let firstInvoice: SaasInvoiceDto;
  let firstPayment: { id: number; gatewayOrderId: string; amountPaise: number };

  it('issues a GST invoice to convert the trial and activates the plan once paid', async () => {
    const app = await getApp();
    const renew = await request(app).post('/api/subscription/renew').set(bearer(A.token));
    expect(renew.status).toBe(200);
    const inv = renew.body.invoice as SaasInvoiceDto;
    expect(inv).toMatchObject({
      kind: 'subscription',
      status: 'open',
      subtotalPaise: 100_000,
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      igstPaise: 0,
      totalPaise: 118_000,
      balancePaise: 118_000,
    });
    expect(inv.number).toMatch(/^TST\/\d{2}-\d{2}\/\d{6}$/);
    expect(inv.seller).toMatchObject({ name: PROFILE.legalName, gstin: PROFILE.gstin });
    expect(inv.billedTo).toMatchObject({ name: 'Billing Test A', state: 'Karnataka' });
    // Asking again returns the same open invoice.
    const again = await request(app).post('/api/subscription/renew').set(bearer(A.token));
    expect(again.body.invoice.id).toBe(inv.id);

    // Retries with the same idempotency key resume the same gateway order.
    const key = `first-${RUN}`;
    const c1 = await request(app)
      .post(`/api/subscription/invoices/${inv.id}/checkout`)
      .set(bearer(A.token))
      .set('Idempotency-Key', key);
    expect(c1.status).toBe(201);
    expect(c1.body.gateway).toBe('mock');
    expect(c1.body.payment).toMatchObject({ status: 'pending', amountPaise: 118_000 });
    const c2 = await request(app)
      .post(`/api/subscription/invoices/${inv.id}/checkout`)
      .set(bearer(A.token))
      .set('Idempotency-Key', key);
    expect(c2.status).toBe(201);
    expect(c2.body.payment.id).toBe(c1.body.payment.id);

    firstPayment = await payOnline(A, inv, key);
    expect(firstPayment.id).toBe(c1.body.payment.id);
    const detail = await request(app).get(`/api/subscription/invoices/${inv.id}`).set(bearer(A.token));
    expect(detail.body.invoice).toMatchObject({ status: 'paid', paidPaise: 118_000, balancePaise: 0 });
    expect(detail.body.payments).toHaveLength(1);
    firstInvoice = detail.body.invoice;

    const o = await overview(A);
    expect(o.status.state).toBe('active');
    expect(o.subscription.status).toBe('active');
    expect(o.subscription.currentPeriodStart).toBe(inv.periodStart);
    expect(o.subscription.endsAt).toBe(inv.periodEnd);

    const payments = await request(app).get('/api/subscription/payments').set(bearer(A.token));
    expect(payments.body.items[0]).toMatchObject({
      id: firstPayment.id,
      status: 'success',
      method: 'gateway',
    });

    // A paid invoice cannot be checked out again, also not with a reused key on another invoice.
    const paidAgain = await request(app)
      .post(`/api/subscription/invoices/${inv.id}/checkout`)
      .set(bearer(A.token))
      .set('Idempotency-Key', `other-${RUN}`);
    expect(paidAgain.status).toBe(409);
    expect(paidAgain.body.error.code).toBe('INVOICE_NOT_OPEN');
  });

  it('validates webhooks and ignores replays', async () => {
    const order = firstPayment.gatewayOrderId;
    const event = {
      event: 'payment.captured',
      gatewayOrderId: order,
      gatewayPaymentId: `pay_${order}`,
      amountPaise: firstPayment.amountPaise,
      status: 'success',
    };
    const replay = await postWebhook({ ...event, eventId: `evt_${order}_success` });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ received: true, outcome: 'duplicate', paymentId: firstPayment.id });

    const again = await postWebhook({ ...event, eventId: `bt-${RUN}-again` });
    expect(again.body.outcome).toBe('already_processed');

    const forged = await postWebhook({ ...event, eventId: `bt-${RUN}-forged` }, 'not-the-secret');
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');

    const unknown = await postWebhook({
      ...event,
      eventId: `bt-${RUN}-unmatched`,
      gatewayOrderId: 'mock_saas_999999999',
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.outcome).toBe('unmatched');

    const gateway = await request(await getApp())
      .post('/api/subscriptions/public/webhooks/nope')
      .send({});
    expect(gateway.status).toBe(404);
  });

  it('serves the invoice PDF through a short-lived signed link', async () => {
    const app = await getApp();
    const link = await request(app)
      .get(`/api/subscription/invoices/${firstInvoice.id}/pdf`)
      .set(bearer(A.token));
    expect(link.status).toBe(200);
    const path = new URL(link.body.url).pathname;
    const pdf = await request(app)
      .get(path)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const tampered = path.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    expect((await request(app).get(tampered)).status).not.toBe(200);
  });

  it('prorates an upgrade and schedules a downgrade for the period end', async () => {
    const app = await getApp();
    const up = await request(app)
      .post('/api/subscription/plan-change')
      .set(bearer(A.token))
      .send({ planId: planIds.pro, billingCycle: 'monthly' });
    expect(up.status).toBe(200);
    expect(up.body.applied).toBe(false);
    // The paid term has not started yet (it follows the trial), so the whole price difference is due.
    expect(up.body.invoice).toMatchObject({ kind: 'upgrade', subtotalPaise: 200_000, totalPaise: 236_000 });
    expect((await overview(A)).plan.id).toBe(planIds.basic);

    const pay = await request(app)
      .post(`/api/admin/billing/invoices/${up.body.invoice.id}/payments`)
      .set(bearer(sa))
      .send({ amountPaise: 236_000, reference: 'NEFT-123' });
    expect(pay.status).toBe(201);
    expect(pay.body.invoice.status).toBe('paid');
    expect(pay.body.payment).toMatchObject({ method: 'manual', status: 'success' });
    let o = await overview(A);
    expect(o.plan.id).toBe(planIds.pro);
    expect(o.limits.maxStudents).toBe(200);

    const down = await request(app)
      .post('/api/subscription/plan-change')
      .set(bearer(A.token))
      .send({ planId: planIds.basic, billingCycle: 'monthly' });
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({ applied: true, invoice: null });
    o = await overview(A);
    expect(o.plan.id).toBe(planIds.pro);
    expect(o.subscription.pendingPlanId).toBe(planIds.basic);

    expect((await request(app).delete('/api/subscription/plan-change').set(bearer(A.token))).status).toBe(
      204,
    );
    expect((await overview(A)).subscription.pendingPlanId).toBeNull();
    const nothing = await request(app).delete('/api/subscription/plan-change').set(bearer(A.token));
    expect(nothing.status).toBe(409);
    expect(nothing.body.error.code).toBe('NO_PENDING_CHANGE');

    const blocked = await request(app)
      .post('/api/subscription/plan-change')
      .set(bearer(A.token))
      .send({ planId: planIds.tiny, billingCycle: 'monthly' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DOWNGRADE_BLOCKED');
    expect(blocked.body.error.details.blockedBy).toEqual([{ metric: 'branches', used: 1, limit: 0 }]);
  });

  it('activates add-ons once paid or credited', async () => {
    const app = await getApp();
    const students = await request(app)
      .post('/api/subscription/addons')
      .set(bearer(A.token))
      .send({ kind: 'students', quantity: 1 });
    expect(students.status).toBe(201);
    expect(students.body.invoice).toMatchObject({ kind: 'addon', subtotalPaise: 20_000, totalPaise: 23_600 });
    expect((await overview(A)).limits.maxStudents).toBe(200);

    // A credit note that settles the invoice applies what it bought.
    const credit = await request(app)
      .post(`/api/admin/billing/invoices/${students.body.invoice.id}/credit-notes`)
      .set(bearer(sa))
      .send({ amountPaise: 23_600, reason: 'Launch goodwill' });
    expect(credit.status).toBe(201);
    expect(credit.body.creditNote.number).toMatch(/^TCN\/\d{2}-\d{2}\/\d{6}$/);
    expect(credit.body.creditNote).toMatchObject({
      amountPaise: 23_600,
      taxablePaise: 20_000,
      taxPaise: 3_600,
    });
    expect(credit.body.invoice).toMatchObject({ status: 'paid', creditedPaise: 23_600, balancePaise: 0 });
    let o = await overview(A);
    expect(o.limits.maxStudents).toBe(210);
    expect(o.addons).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'students', status: 'active', quantity: 1 })]),
    );
    const over = await request(app)
      .post(`/api/admin/billing/invoices/${students.body.invoice.id}/credit-notes`)
      .set(bearer(sa))
      .send({ amountPaise: 1, reason: 'Too much' });
    expect(over.status).toBe(400);

    const ai = await request(app)
      .post('/api/subscription/addons')
      .set(bearer(A.token))
      .send({ kind: 'ai_credits', quantity: 1 });
    expect(ai.status).toBe(201);
    expect(ai.body.invoice).toMatchObject({ kind: 'addon', subtotalPaise: 30_000 });
    await payOnline(A, ai.body.invoice);
    o = await overview(A);
    expect(o.ai).toMatchObject({ creditsThisMonth: 50_000, includedThisMonth: 150_000 });
  });

  it('keeps a lapsed institute usable in grace, then read-only, then suspended', async () => {
    const app = await getApp();
    const [main] = (await request(app).get('/api/branches').set(bearer(A.token))).body as { id: number }[];
    const write = () =>
      request(app).patch(`/api/branches/${main.id}`).set(bearer(A.token)).send({ name: 'Main Branch' });

    await setEndsAt(A, new Date(Date.now() - DAY));
    let status = await request(app).get('/api/subscription/status').set(bearer(A.token));
    expect(status.body.state).toBe('grace');
    expect(status.body.message).toBeTruthy();
    expect((await write()).status).toBe(200);
    const lapsedAddon = await request(app)
      .post('/api/subscription/addons')
      .set(bearer(A.token))
      .send({ kind: 'ai_credits', quantity: 1 });
    expect(lapsedAddon.status).toBe(409);
    expect(lapsedAddon.body.error.code).toBe('SUBSCRIPTION_LAPSED');

    await setEndsAt(A, new Date(Date.now() - 8 * DAY));
    expect((await request(app).get('/api/branches').set(bearer(A.token))).status).toBe(200);
    const readOnly = await write();
    expect(readOnly.status).toBe(402);
    expect(readOnly.body.error.code).toBe('SUBSCRIPTION_RESTRICTED');
    status = await request(app).get('/api/subscription/status').set(bearer(A.token));
    expect(status.body.state).toBe('restricted');

    await setEndsAt(A, new Date(Date.now() - 40 * DAY));
    const blocked = await request(app).get('/api/branches').set(bearer(A.token));
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('SUBSCRIPTION_SUSPENDED');
    // The super admin (and support while impersonating) is never blocked.
    expect((await request(app).get(`/api/admin/institutes/${A.id}`).set(bearer(sa))).status).toBe(200);

    // Billing stays reachable so the institute can renew itself.
    const renew = await request(app).post('/api/subscription/renew').set(bearer(A.token));
    expect(renew.status).toBe(200);
    expect(renew.body.invoice.kind).toBe('renewal');
    // The plan (pro) and the recurring students pack renew together, as a new term from today.
    expect(renew.body.invoice.subtotalPaise).toBe(320_000);
    expect(Math.abs(new Date(renew.body.invoice.periodStart).getTime() - Date.now())).toBeLessThan(60_000);
    await payOnline(A, renew.body.invoice);
    status = await request(app).get('/api/subscription/status').set(bearer(A.token));
    expect(status.body.state).toBe('active');
    expect((await request(app).get('/api/branches').set(bearer(A.token))).status).toBe(200);
    expect((await write()).status).toBe(200);
  });

  it('lets the super admin suspend and reactivate an institute', async () => {
    const app = await getApp();
    const suspend = await request(app)
      .post(`/api/admin/billing/institutes/${A.id}/suspend`)
      .set(bearer(sa))
      .send({ reason: 'Chargeback dispute' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.suspendReason).toBe('Chargeback dispute');
    const blocked = await request(app).get('/api/branches').set(bearer(A.token));
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('SUBSCRIPTION_SUSPENDED');
    const twice = await request(app)
      .post(`/api/admin/billing/institutes/${A.id}/suspend`)
      .set(bearer(sa))
      .send({ reason: 'Again' });
    expect(twice.body.error.code).toBe('ALREADY_SUSPENDED');
    const selfRenew = await request(app).post('/api/subscription/renew').set(bearer(A.token));
    expect(selfRenew.status).toBe(409);
    expect(selfRenew.body.error.code).toBe('SUBSCRIPTION_SUSPENDED');

    const reactivate = await request(app)
      .post(`/api/admin/billing/institutes/${A.id}/reactivate`)
      .set(bearer(sa))
      .send({});
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.suspendedAt).toBeNull();
    expect((await request(app).get('/api/branches').set(bearer(A.token))).status).toBe(200);
  });

  it('lists subscriptions, invoices, payments and credit notes for the super admin', async () => {
    const app = await getApp();
    const subs = await request(app)
      .get('/api/admin/billing/subscriptions')
      .query({ search: A.slug })
      .set(bearer(sa));
    expect(subs.status).toBe(200);
    expect(subs.body.items).toHaveLength(1);
    expect(subs.body.items[0]).toMatchObject({ instituteId: A.id, state: 'active', openBalancePaise: 0 });
    expect(subs.body.items[0].subscription.plan.id).toBe(planIds.pro);

    const invoices = await request(app)
      .get('/api/admin/billing/invoices')
      .query({ instituteId: A.id, status: 'paid' })
      .set(bearer(sa));
    expect(invoices.body.items.map((i: { kind: string }) => i.kind).sort()).toEqual([
      'addon',
      'addon',
      'renewal',
      'subscription',
      'upgrade',
    ]);
    const payments = await request(app)
      .get('/api/admin/billing/payments')
      .query({ instituteId: A.id, status: 'success' })
      .set(bearer(sa));
    expect(payments.body.items).toHaveLength(4);
    const notes = await request(app)
      .get('/api/admin/billing/credit-notes')
      .query({ instituteId: A.id })
      .set(bearer(sa));
    expect(notes.body.items).toHaveLength(1);
    const tenantNotes = await request(app).get('/api/subscription/credit-notes').set(bearer(A.token));
    expect(tenantNotes.body.items).toHaveLength(1);
  });

  let manual: SaasInvoiceDto;

  it('raises manual invoices with IGST for another state, and voids them', async () => {
    const app = await getApp();
    const res = await request(app)
      .post('/api/admin/billing/invoices')
      .set(bearer(sa))
      .send({
        instituteId: B.id,
        lines: [{ description: 'Data migration', quantity: 2, unitPricePaise: 50_000 }],
      });
    expect(res.status).toBe(201);
    manual = res.body;
    expect(manual).toMatchObject({
      kind: 'manual',
      subtotalPaise: 100_000,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 18_000,
      totalPaise: 118_000,
    });
    expect(manual.billedTo.state).toBe('Maharashtra');

    // Tenants only see their own invoices; billing administration is for the super admin.
    expect(
      (await request(app).get(`/api/subscription/invoices/${manual.id}`).set(bearer(A.token))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/subscription/invoices/${manual.id}`).set(bearer(B.token))).status,
    ).toBe(200);
    expect((await request(app).get('/api/admin/billing/invoices').set(bearer(A.token))).status).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/subscription/invoices/${manual.id}/checkout`)
          .set(bearer(A.token))
          .set('Idempotency-Key', `cross-${RUN}`)
      ).status,
    ).toBe(404);

    const voided = await request(app)
      .post(`/api/admin/billing/invoices/${manual.id}/void`)
      .set(bearer(sa))
      .send({ reason: 'Raised in error' });
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({ status: 'void', voidReason: 'Raised in error' });
  });

  it('rejects a webhook whose amount does not match the payment', async () => {
    const app = await getApp();
    const inv = await request(app)
      .post('/api/admin/billing/invoices')
      .set(bearer(sa))
      .send({ instituteId: B.id, lines: [{ description: 'Training session', unitPricePaise: 10_000 }] });
    expect(inv.status).toBe(201);
    const checkout = await request(app)
      .post(`/api/subscription/invoices/${inv.body.id}/checkout`)
      .set(bearer(B.token))
      .set('Idempotency-Key', `mismatch-${RUN}`);
    expect(checkout.status).toBe(201);
    const order = checkout.body.payment.gatewayOrderId as string;
    const res = await postWebhook({
      eventId: `bt-${RUN}-mismatch`,
      gatewayOrderId: order,
      gatewayPaymentId: `pay_${order}`,
      amountPaise: 1,
      status: 'success',
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('amount_mismatch');
    const detail = await request(app).get(`/api/subscription/invoices/${inv.body.id}`).set(bearer(B.token));
    expect(detail.body.invoice).toMatchObject({ status: 'open', paidPaise: 0 });

    // The same idempotency key cannot pay a different invoice.
    const reused = await request(app)
      .post(`/api/subscription/invoices/${inv.body.id}/checkout`)
      .set(bearer(B.token))
      .set('Idempotency-Key', `mismatch-${RUN}`);
    expect(reused.status).toBe(201);
    const other = await request(app)
      .post('/api/admin/billing/invoices')
      .set(bearer(sa))
      .send({ instituteId: B.id, lines: [{ description: 'Second session', unitPricePaise: 10_000 }] });
    const conflict = await request(app)
      .post(`/api/subscription/invoices/${other.body.id}/checkout`)
      .set(bearer(B.token))
      .set('Idempotency-Key', `mismatch-${RUN}`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('meters usage daily and bills overage for soft limits after the month ends', async () => {
    const app = await getApp();
    const second = await request(app)
      .post('/api/branches')
      .set(bearer(B.token))
      .send({ name: 'Second', code: 'B2' });
    expect(second.status).toBe(201);

    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const sweep = async (at: Date) => {
      const result: BillingSweepResult = {
        institutes: 0,
        renewalInvoices: 0,
        overageInvoices: 0,
        notices: 0,
        failures: 0,
      };
      const policy = await getBillingPolicy();
      await runWithContext({ system: true, instituteId: B.id, allowedBranchIds: null }, () =>
        sweepInstitute(B.id, policy, at, result),
      );
      return result;
    };
    // The first sweep snapshots today's usage and starts billing from this month.
    expect(await sweep(now)).toMatchObject({ overageInvoices: 0, failures: 0 });
    const snaps = await request(app).get('/api/subscription/usage/snapshots').set(bearer(B.token));
    expect(snaps.status).toBe(200);
    expect(snaps.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ snapshotDate: now.toISOString().slice(0, 10), branches: 2 }),
      ]),
    );
    const usage = await request(app)
      .get(`/api/admin/billing/usage`)
      .query({ instituteId: B.id })
      .set(bearer(sa));
    expect(usage.body[0]).toMatchObject({ instituteId: B.id, branches: 2 });
    expect((await usageSummary({ instituteId: B.id }))[0].branches).toBe(2);

    // Early next month the completed month is billed once: the peak of 2 branches against 1 included.
    expect(await sweep(new Date(nextMonth.getTime() + DAY))).toMatchObject({
      overageInvoices: 1,
      failures: 0,
    });
    expect(await sweep(new Date(nextMonth.getTime() + 2 * DAY))).toMatchObject({ overageInvoices: 0 });
    const invoices = await request(app)
      .get('/api/subscription/invoices')
      .query({ kind: 'overage' })
      .set(bearer(B.token));
    expect(invoices.body.items).toHaveLength(1);
    expect(invoices.body.items[0]).toMatchObject({
      subtotalPaise: 50_000,
      igstPaise: 9_000,
      totalPaise: 59_000,
    });
  });

  it('closes and reactivates branches within the plan limits', async () => {
    const app = await getApp();
    const branches = (await request(app).get('/api/branches').set(bearer(B.token))).body as {
      id: number;
      code: string;
    }[];
    const main = branches.find((b) => b.code === 'MAIN')!;
    const b2 = branches.find((b) => b.code === 'B2')!;
    const act = (id: number, action: 'close' | 'activate') =>
      request(app).post(`/api/branches/${id}/${action}`).set(bearer(B.token)).send({ reason: 'Test' });

    expect((await act(b2.id, 'close')).body.status).toBe('closed');
    const last = await act(main.id, 'close');
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_ACTIVE_BRANCH');
    expect((await act(b2.id, 'activate')).body.status).toBe('active');
    const patch = await request(app)
      .patch(`/api/branches/${b2.id}`)
      .set(bearer(B.token))
      .send({ status: 'closed' });
    expect(patch.status).toBe(400);

    // 1 branch included + 2 billable overage branches.
    const b3 = await request(app)
      .post('/api/branches')
      .set(bearer(B.token))
      .send({ name: 'Third', code: 'B3' });
    expect(b3.status).toBe(201);
    const b4 = await request(app)
      .post('/api/branches')
      .set(bearer(B.token))
      .send({ name: 'Fourth', code: 'B4' });
    expect(b4.status).toBe(402);
    expect(b4.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');

    const student = await request(app)
      .post('/api/students')
      .set(bearer(B.token))
      .send({ name: 'Branch Student', mobile: mobile(), branchId: b3.body.id });
    expect(student.status).toBe(201);
    const inUse = await act(b3.body.id, 'close');
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('BRANCH_IN_USE');
    expect(inUse.body.error.details.blockers[0]).toContain('student');

    // Closing frees a slot; activating again is checked against the limit.
    expect((await act(b2.id, 'close')).status).toBe(200);
    expect(
      (await request(app).post('/api/branches').set(bearer(B.token)).send({ name: 'Fourth', code: 'B4' }))
        .status,
    ).toBe(201);
    const over = await act(b2.id, 'activate');
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('exposes revenue and subscription figures for the reports dashboard', async () => {
    const byPlan = await subscriptionsByPlan();
    expect(byPlan.find((p) => p.planId === planIds.pro)).toMatchObject({
      subscriptions: 1,
      trials: 0,
      mrrPaise: 320_000,
    });
    expect(byPlan.find((p) => p.planId === planIds.basic)).toMatchObject({ subscriptions: 0, mrrPaise: 0 });

    const month = billingDate();
    const [point] = await revenueByMonth({ from: month, to: month });
    expect(point.collectedPaise).toBeGreaterThanOrEqual(118_000 + 236_000);
    expect(point.creditedPaise).toBeGreaterThanOrEqual(23_600);
  });

  it('validates billing settings', async () => {
    const app = await getApp();
    const same = await request(app)
      .put('/api/admin/billing/settings/profile')
      .set(bearer(sa))
      .send({ ...PROFILE, creditNotePrefix: PROFILE.invoicePrefix });
    expect(same.status).toBe(400);
    const gstin = await request(app)
      .put('/api/admin/billing/settings/profile')
      .set(bearer(sa))
      .send({ ...PROFILE, gstin: 'NOT-A-GSTIN' });
    expect(gstin.status).toBe(422);
    expect(gstin.body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(app).get('/api/admin/billing/settings').set(bearer(A.token))).status).toBe(403);
    const settings = await request(app).get('/api/admin/billing/settings').set(bearer(sa));
    expect(settings.body.profile).toMatchObject({ invoicePrefix: 'TST', state: 'Karnataka' });
  });
});
