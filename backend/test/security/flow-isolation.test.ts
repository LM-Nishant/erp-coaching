/**
 * Cross-tenant checks on records produced by the real final-wave flows (the tenant-isolation crawl
 * probes every record route with synthesized rows; these follow the actual flows end to end):
 * SaaS subscribe → mock payment → invoice → credit note, tenant data export, admin device
 * revocation, report export download, and institute deletion keeping the operator's SaaS
 * invoices, payments and credit notes with `institute_id` NULL.
 */
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSequelize } from '../../src/infrastructure/database/sequelize';
import { processDueJobs } from '../../src/infrastructure/jobs/queue';
import { bearer, getApp, login, newDevice, purgeRows, USERS } from '../helpers';

const RUN = Date.now().toString(36);
const PASSWORD = 'Password@123';
let seq = Math.floor(Math.random() * 9_000_000);
/** 948… is this suite's mobile range. */
const mobile = () => `948${String(seq++ % 10_000_000).padStart(7, '0')}`;

interface Tenant {
  id: number;
  slug: string;
  token: string;
  branchId: number;
  roleIds: Record<string, number>;
}
let sa: string;
let A: Tenant;
let B: Tenant;
const invoiceIds: number[] = [];

const query = <T>(sql: string, replacements: unknown[] = []) =>
  getSequelize().query<T>(sql, { replacements, type: QueryTypes.SELECT });

async function call(method: 'get' | 'post' | 'put' | 'delete', path: string, token: string, body?: object) {
  const req = request(await getApp())
    [method](path)
    .set(bearer(token));
  return body === undefined ? req : req.send(body);
}

async function createInstitute(label: string): Promise<Tenant> {
  const [plan] = await query<{ id: number }>("SELECT id FROM plans WHERE code = 'growth'");
  const adminMobile = mobile();
  const slug = `fw-${label}-${RUN}`;
  const res = await call('post', '/api/admin/institutes', sa, {
    name: `Flow Isolation ${label}`,
    slug,
    planId: plan.id,
    state: 'Karnataka',
    admin: { name: `Admin ${label}`, mobile: adminMobile, password: PASSWORD },
  });
  expect(res.status).toBe(201);
  const token = (await login({ mobile: adminMobile, password: PASSWORD })).accessToken;
  const [branches, roles] = await Promise.all([
    call('get', '/api/branches', token),
    call('get', '/api/roles', token),
  ]);
  return {
    id: res.body.id,
    slug,
    token,
    branchId: branches.body[0].id,
    roleIds: Object.fromEntries(roles.body.map((r: { slug: string; id: number }) => [r.slug, r.id])),
  };
}

async function addTeacher(t: Tenant, name: string) {
  const credentials = { name, mobile: mobile(), password: PASSWORD };
  const res = await call('post', '/api/users', t.token, {
    ...credentials,
    roles: [{ roleId: t.roleIds.teacher, branchId: null }],
    branchIds: [t.branchId],
  });
  expect(res.status).toBe(201);
  return { id: res.body.id as number, ...credentials };
}

beforeAll(async () => {
  sa = (await login(USERS.superAdmin)).accessToken;
  A = await createInstitute('a');
  B = await createInstitute('b');
});

afterAll(async () => {
  const sequelize = getSequelize();
  const ids = [A?.id, B?.id].filter((x): x is number => !!x);
  const invoices = [
    ...invoiceIds,
    ...(ids.length
      ? (
          await query<{ id: number }>('SELECT id FROM subscription_invoices WHERE institute_id IN (?)', [ids])
        ).map((r) => r.id)
      : []),
  ];
  if (invoices.length) {
    await sequelize.query('DELETE FROM subscription_credit_notes WHERE invoice_id IN (?)', {
      replacements: [invoices],
    });
    await sequelize.query('DELETE FROM subscription_payments WHERE invoice_id IN (?)', {
      replacements: [invoices],
    });
    await purgeRows('subscription_invoices', invoices);
  }
  if (ids.length) {
    await sequelize.query('DELETE FROM audit_events WHERE institute_id IN (?)', { replacements: [ids] });
    const live = (await query<{ id: number }>('SELECT id FROM institutes WHERE id IN (?)', [ids])).map(
      (r) => r.id,
    );
    if (live.length) await purgeRows('institutes', live);
  }
  const users = await query<{ id: number }>("SELECT id FROM users WHERE mobile LIKE '948%'");
  await purgeRows(
    'users',
    users.map((r) => r.id),
  );
});

describe('final-wave flows across institutes', () => {
  let invoice: { id: number; number: string };
  let paymentId: number;
  let creditNoteId: number;

  it('SaaS subscribe → mock payment → invoice → credit note stays with its institute', async () => {
    const renew = await call('post', '/api/subscription/renew', A.token);
    expect(renew.status).toBe(200);
    invoice = renew.body.invoice;
    invoiceIds.push(invoice.id);

    // B can neither see nor pay A's invoice.
    expect((await call('get', `/api/subscription/invoices/${invoice.id}`, B.token)).status).toBe(404);
    expect((await call('get', `/api/subscription/invoices/${invoice.id}/pdf`, B.token)).status).toBe(404);
    expect(
      (await call('post', `/api/subscription/invoices/${invoice.id}/checkout`, B.token, {})).status,
    ).toBe(404);

    const checkout = await call('post', `/api/subscription/invoices/${invoice.id}/checkout`, A.token, {
      idempotencyKey: `fw-${RUN}-checkout`,
    });
    expect(checkout.status).toBe(201);
    paymentId = checkout.body.payment.id;
    const stolen = await call('post', `/api/subscription/payments/${paymentId}/mock-complete`, B.token, {
      outcome: 'success',
    });
    expect(stolen.status).toBe(404);
    expect((await call('get', `/api/subscription/invoices/${invoice.id}`, A.token)).body.invoice.status).toBe(
      'open',
    );

    const paid = await call('post', `/api/subscription/payments/${paymentId}/mock-complete`, A.token, {
      outcome: 'success',
    });
    expect(paid.body.outcome).toBe('paid');
    const detail = await call('get', `/api/subscription/invoices/${invoice.id}`, A.token);
    expect(detail.body.invoice).toMatchObject({ status: 'paid', balancePaise: 0 });

    const credit = await call('post', `/api/admin/billing/invoices/${invoice.id}/credit-notes`, sa, {
      amountPaise: 1000,
      reason: 'Goodwill credit',
    });
    expect(credit.status).toBe(201);
    creditNoteId = credit.body.creditNote.id;
    expect((await call('get', `/api/subscription/credit-notes/${creditNoteId}/pdf`, A.token)).status).toBe(
      200,
    );
    expect((await call('get', `/api/subscription/credit-notes/${creditNoteId}/pdf`, B.token)).status).toBe(
      404,
    );

    const lists = await Promise.all(
      ['/api/subscription/invoices', '/api/subscription/credit-notes'].map((p) => call('get', p, B.token)),
    );
    for (const list of lists) {
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(invoice.number);
    }
  });

  it('tenant data exports are private to their institute', async () => {
    const created = await call('post', '/api/tenant-data/exports', A.token, { includeMedia: false });
    expect(created.status).toBe(201);
    await processDueJobs(200);
    expect((await call('post', `/api/tenant-data/exports/${created.body.id}/link`, B.token, {})).status).toBe(
      404,
    );
    expect((await call('delete', `/api/tenant-data/exports/${created.body.id}`, B.token)).status).toBe(404);
    const link = await call('post', `/api/tenant-data/exports/${created.body.id}/link`, A.token, {});
    expect(link.status).toBe(200);
  }, 60_000);

  it("an admin revokes only their own institute's member devices", async () => {
    const teacherA = await addTeacher(A, 'Flow Teacher A');
    const teacherB = await addTeacher(B, 'Flow Teacher B');
    const session = await login(teacherA, newDevice('android'));
    const devices = await call('get', `/api/users/${teacherA.id}/devices`, A.token);
    expect(devices.status).toBe(200);
    const device = devices.body.find((d: { uid?: string; status: string }) => d.status === 'active');
    expect(device).toBeDefined();

    expect((await call('get', `/api/users/${teacherA.id}/devices`, B.token)).status).toBe(404);
    expect((await call('delete', `/api/users/${teacherA.id}/devices/${device.id}`, B.token)).status).toBe(
      404,
    );
    // B's own member id with A's device id: the device must belong to that member.
    expect((await call('delete', `/api/users/${teacherB.id}/devices/${device.id}`, B.token)).status).toBe(
      404,
    );
    expect((await call('get', '/api/auth/me', session.accessToken)).status).toBe(200);

    expect((await call('delete', `/api/users/${teacherA.id}/devices/${device.id}`, A.token)).status).toBe(
      204,
    );
    const after = await call('get', '/api/auth/me', session.accessToken);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('report exports are private to the user who made them', async () => {
    const created = await call('post', '/api/reports/capacity/exports', A.token, { format: 'csv' });
    expect([201, 202]).toContain(created.status);
    await processDueJobs(200);
    expect((await call('get', `/api/reports/exports/${created.body.id}`, B.token)).status).toBe(404);
    expect((await call('post', `/api/reports/exports/${created.body.id}/download`, B.token, {})).status).toBe(
      404,
    );
    const own = await call('post', `/api/reports/exports/${created.body.id}/download`, A.token, {});
    expect(own.status).toBe(200);
  }, 60_000);

  it('deleting an institute keeps its SaaS invoices, payments and credit notes, detached', async () => {
    const requested = await call('post', '/api/tenant-data/deletion-request', A.token, { confirm: A.slug });
    expect(requested.status).toBe(201);
    const approved = await call(
      'post',
      `/api/admin/tenant-data/deletion-requests/${requested.body.id}/approve`,
      sa,
      {
        graceDays: 0,
      },
    );
    expect(approved.status).toBe(200);
    await processDueJobs(200);
    expect(await query('SELECT id FROM institutes WHERE id = ?', [A.id])).toEqual([]);

    expect(await query('SELECT institute_id FROM subscription_invoices WHERE id = ?', [invoice.id])).toEqual([
      { institute_id: null },
    ]);
    expect(await query('SELECT institute_id FROM subscription_payments WHERE id = ?', [paymentId])).toEqual([
      { institute_id: null },
    ]);
    expect(
      await query('SELECT institute_id FROM subscription_credit_notes WHERE id = ?', [creditNoteId]),
    ).toEqual([{ institute_id: null }]);
    // The operator still has them; no institute does.
    expect((await call('get', `/api/admin/billing/invoices/${invoice.id}`, sa)).status).toBe(200);
    expect((await call('get', `/api/admin/billing/credit-notes/${creditNoteId}/pdf`, sa)).status).toBe(200);
    expect((await call('get', `/api/subscription/invoices/${invoice.id}`, B.token)).status).toBe(404);
    expect((await call('get', `/api/subscription/credit-notes/${creditNoteId}/pdf`, B.token)).status).toBe(
      404,
    );
  }, 60_000);
});
