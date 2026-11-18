/**
 * The unauthenticated SaaS billing and tenant-data routes: signed document and export links, and
 * the payment gateway webhook. Bad, expired, tampered, cross-tenant and cross-purpose tokens are
 * refused with a bare 4xx (nothing about the document or institute leaks); forged webhooks are
 * rejected and rate limited; replayed webhooks change nothing.
 */
import express from 'express';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/infrastructure/config';
import { hmac } from '../src/infrastructure/crypto';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { MOCK_SIGNATURE_HEADER, signMockWebhook } from '../src/infrastructure/payment-gateways/mock.gateway';
import { getStorage } from '../src/infrastructure/storage';
import { signDocumentToken } from '../src/modules/subscriptions/documents';
import { bearer, getApp, login, purgeRows, USERS } from './helpers';

const RUN = Date.now().toString(36);
const PASSWORD = 'Password@123';
let seq = Math.floor(Math.random() * 9_000_000);
/** 948… is this suite's mobile range. */
const mobile = () => `948${String(seq++ % 10_000_000).padStart(7, '0')}`;
const DOCS = '/api/subscriptions/public/documents';
const EXPORTS = '/api/tenant-data/public/exports';
const WEBHOOK = '/api/subscriptions/public/webhooks/mock';

interface Tenant {
  id: number;
  slug: string;
  token: string;
}
let sa: string;
let A: Tenant;
let B: Tenant;
let invoiceA: { id: number; number: string };
let invoiceB: { id: number; number: string };
let exportA: { id: number; key: string };

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims: object, secret: string) => {
  const body = b64(claims);
  return `${body}.${hmac(body, secret)}`;
};
const DOC_SECRET = () => `${config.FILE_URL_SECRET}:saas-document`;
const EXPORT_SECRET = () => `${config.FILE_URL_SECRET}:tenant-export`;
const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;
const tokenOf = (url: string) => url.split('/').pop()!;

async function fetchPublic(path: string) {
  return request(await getApp())
    .get(path)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
}

/** A refused link: a short JSON error that says nothing about the document, export or institute. */
async function expectRefused(path: string, secrets: string[], status = 404) {
  const res = await fetchPublic(path);
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.headers['content-disposition']).toBeUndefined();
  const text = (res.body as Buffer).toString();
  expect(Object.keys(JSON.parse(text))).toEqual(['error']);
  for (const s of secrets) expect(text).not.toContain(s);
  expect(text).not.toMatch(/stack|sql|institute_id|storage/i);
}

async function createInstitute(label: string): Promise<Tenant> {
  const [plan] = await getSequelize().query<{ id: number }>("SELECT id FROM plans WHERE code = 'starter'", {
    type: QueryTypes.SELECT,
  });
  const adminMobile = mobile();
  const slug = `pt-${label}-${RUN}`;
  const res = await request(await getApp())
    .post('/api/admin/institutes')
    .set(bearer(sa))
    .send({
      name: `Public Token ${label}`,
      slug,
      planId: plan.id,
      state: 'Karnataka',
      admin: { name: `Admin ${label}`, mobile: adminMobile, password: PASSWORD },
    });
  expect(res.status).toBe(201);
  return {
    id: res.body.id,
    slug,
    token: (await login({ mobile: adminMobile, password: PASSWORD })).accessToken,
  };
}

async function openInvoice(t: Tenant) {
  const res = await request(await getApp())
    .post('/api/subscription/renew')
    .set(bearer(t.token));
  expect(res.status).toBe(200);
  return res.body.invoice as { id: number; number: string };
}

function postWebhook(body: Record<string, unknown>, secret = 'mock-webhook-secret') {
  const raw = JSON.stringify(body);
  return getApp().then((app) =>
    request(app)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signMockWebhook(secret, raw))
      .send(raw),
  );
}

beforeAll(async () => {
  sa = (await login(USERS.superAdmin)).accessToken;
  A = await createInstitute('a');
  B = await createInstitute('b');
  invoiceA = await openInvoice(A);
  invoiceB = await openInvoice(B);
});

afterAll(async () => {
  const sequelize = getSequelize();
  const ids = [A?.id, B?.id].filter((x): x is number => !!x);
  if (exportA) await getStorage().delete(exportA.key);
  if (ids.length) {
    const select = async (sql: string) =>
      (await sequelize.query<{ id: number }>(sql, { replacements: [ids], type: QueryTypes.SELECT })).map(
        (r) => r.id,
      );
    await sequelize.query('DELETE FROM subscription_payments WHERE institute_id IN (?)', {
      replacements: [ids],
    });
    await purgeRows(
      'subscription_invoices',
      await select('SELECT id FROM subscription_invoices WHERE institute_id IN (?)'),
    );
    await sequelize.query('DELETE FROM audit_events WHERE institute_id IN (?)', { replacements: [ids] });
    await purgeRows('institutes', ids);
  }
  const users = await sequelize.query<{ id: number }>("SELECT id FROM users WHERE mobile LIKE '948%'", {
    type: QueryTypes.SELECT,
  });
  await purgeRows(
    'users',
    users.map((r) => r.id),
  );
});

describe('signed SaaS document links', () => {
  it('serves the PDF for a genuine link', async () => {
    const link = await request(await getApp())
      .get(`/api/subscription/invoices/${invoiceA.id}/pdf`)
      .set(bearer(A.token));
    expect(link.status).toBe(200);
    const res = await fetchPublic(new URL(link.body.url).pathname);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('refuses malformed, forged, expired, cross-tenant and cross-purpose tokens', async () => {
    const leaks = [invoiceA.number, invoiceB.number, A.slug, B.slug];
    const genuine = tokenOf(signDocumentToken('inv', invoiceA.id, A.id).url);
    const [body, sig] = genuine.split('.');

    await expectRefused(`${DOCS}/short`, leaks, 422);
    await expectRefused(`${DOCS}/not-a-token-at-all`, leaks);
    await expectRefused(`${DOCS}/${body}.${'A'.repeat(sig.length)}`, leaks);
    // Claims edited to another institute's invoice under the original signature.
    await expectRefused(
      `${DOCS}/${b64({ k: 'inv', d: invoiceB.id, i: B.id, e: inSeconds(300) })}.${sig}`,
      leaks,
    );
    // Signed with a guessed secret, or with another link type's secret.
    await expectRefused(
      `${DOCS}/${sign({ k: 'inv', d: invoiceA.id, i: A.id, e: inSeconds(300) }, 'secret')}`,
      leaks,
    );
    await expectRefused(
      `${DOCS}/${sign({ k: 'inv', d: invoiceA.id, i: A.id, e: inSeconds(300) }, EXPORT_SECRET())}`,
      leaks,
    );
    await expectRefused(`${DOCS}/${tokenOf(signDocumentToken('inv', invoiceA.id, A.id, -60).url)}`, leaks);
    // Correctly signed, but the invoice belongs to another institute / is not a credit note.
    await expectRefused(`${DOCS}/${tokenOf(signDocumentToken('inv', invoiceB.id, A.id).url)}`, leaks);
    await expectRefused(`${DOCS}/${tokenOf(signDocumentToken('cn', invoiceA.id, A.id).url)}`, leaks);
    await expectRefused(
      `${DOCS}/${sign({ k: 'pdf', d: invoiceA.id, i: A.id, e: inSeconds(300) }, DOC_SECRET())}`,
      leaks,
    );
  });
});

describe('signed tenant export links', () => {
  it('serves a ready export for a genuine link', async () => {
    const app = await getApp();
    const created = await request(app).post('/api/tenant-data/exports').set(bearer(A.token)).send({
      includeMedia: false,
    });
    expect(created.status).toBe(201);
    await processDueJobs(200);
    const [row] = await getSequelize().query<{ status: string; storage_key: string }>(
      'SELECT status, storage_key FROM data_exports WHERE id = ?',
      { replacements: [created.body.id], type: QueryTypes.SELECT },
    );
    expect(row.status).toBe('ready');
    exportA = { id: created.body.id, key: row.storage_key };
    const link = await request(app)
      .post(`/api/tenant-data/exports/${exportA.id}/link`)
      .set(bearer(A.token))
      .send({});
    expect(link.status).toBe(200);
    const res = await fetchPublic(new URL(link.body.url).pathname);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
  }, 60_000);

  it('refuses malformed, forged, expired, cross-tenant and cross-purpose tokens', async () => {
    const leaks = [A.slug, B.slug, exportA.key];
    const claims = { x: exportA.id, i: A.id, u: null, e: inSeconds(300) };
    const [, sig] = sign(claims, EXPORT_SECRET()).split('.');

    await expectRefused(`${EXPORTS}/garbage`, leaks, 422);
    await expectRefused(`${EXPORTS}/not-a-token-at-all`, leaks);
    await expectRefused(`${EXPORTS}/${b64(claims)}.${'A'.repeat(sig.length)}`, leaks);
    await expectRefused(`${EXPORTS}/${b64({ ...claims, i: B.id })}.${sig}`, leaks);
    await expectRefused(`${EXPORTS}/${sign(claims, 'secret')}`, leaks);
    await expectRefused(`${EXPORTS}/${sign(claims, DOC_SECRET())}`, leaks);
    await expectRefused(`${EXPORTS}/${sign({ ...claims, e: inSeconds(-60) }, EXPORT_SECRET())}`, leaks);
    // Correctly signed for institute B, but the export is A's.
    await expectRefused(`${EXPORTS}/${sign({ ...claims, i: B.id }, EXPORT_SECRET())}`, leaks);
    await expectRefused(`${EXPORTS}/${sign({ ...claims, x: 'x' }, EXPORT_SECRET())}`, leaks);
  });
});

describe('payment gateway webhook', () => {
  it('rejects forged signatures without leaking and ignores replays', async () => {
    const app = await getApp();
    const checkout = await request(app)
      .post(`/api/subscription/invoices/${invoiceA.id}/checkout`)
      .set(bearer(A.token))
      .set('Idempotency-Key', `pt-${RUN}-a`);
    expect(checkout.status).toBe(201);
    const payment = checkout.body.payment as { id: number; gatewayOrderId: string; amountPaise: number };
    const event = {
      event: 'payment.captured',
      gatewayOrderId: payment.gatewayOrderId,
      gatewayPaymentId: `pay_${payment.gatewayOrderId}`,
      amountPaise: payment.amountPaise,
      status: 'success',
      eventId: `pt-${RUN}-captured`,
    };

    const forged = await postWebhook(event, 'not-the-secret');
    expect(forged.status).toBe(401);
    expect(forged.body).toEqual({ error: { code: 'INVALID_SIGNATURE', message: expect.any(String) } });
    expect(JSON.stringify(forged.body)).not.toContain(payment.gatewayOrderId);
    const unsigned = await request(app).post(WEBHOOK).set('Content-Type', 'application/json').send(event);
    expect(unsigned.status).toBe(401);
    const invoice = async () =>
      (await request(app).get(`/api/subscription/invoices/${invoiceA.id}`).set(bearer(A.token))).body
        .invoice as { status: string; paidPaise: number };
    expect((await invoice()).status).toBe('open');

    const first = await postWebhook(event);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, paymentId: payment.id });
    const paid = await invoice();
    expect(paid).toMatchObject({ status: 'paid', paidPaise: payment.amountPaise });

    for (const replay of [event, event, { ...event, eventId: `pt-${RUN}-again` }]) {
      const res = await postWebhook(replay);
      expect(res.status).toBe(200);
      expect(['duplicate', 'already_processed']).toContain(res.body.outcome);
    }
    expect(await invoice()).toEqual(paid);
    const [{ n }] = await getSequelize().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM subscription_payments WHERE invoice_id = ? AND status = 'success'",
      { replacements: [invoiceA.id], type: QueryTypes.SELECT },
    );
    expect(Number(n)).toBe(1);
  });

  it('rate limits webhook traffic per IP', async () => {
    const saved = {
      RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
      RATE_LIMIT_WEBHOOK_PER_MIN: process.env.RATE_LIMIT_WEBHOOK_PER_MIN,
    };
    try {
      // The limiters read their settings when loaded: put a fresh, enabled copy in front of the app.
      Object.assign(process.env, { RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_WEBHOOK_PER_MIN: '2' });
      vi.resetModules();
      const { webhookRateLimit } = await import('../src/shared/middleware/security');
      const app = express();
      app.post(WEBHOOK, webhookRateLimit, await getApp());
      const forged = () =>
        request(app)
          .post(WEBHOOK)
          .set('Content-Type', 'application/json')
          .set(MOCK_SIGNATURE_HEADER, 'forged')
          .send({ eventId: `pt-${RUN}-flood` });
      expect((await forged()).status).toBe(401);
      expect((await forged()).status).toBe(401);
      const limited = await forged();
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
    }
  });
});
