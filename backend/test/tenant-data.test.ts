import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/infrastructure/config';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { getStorage } from '../src/infrastructure/storage';
import { listTenantModels } from '../src/shared/tenancy/tenant-model';
import {
  EXPORT_EXCLUDED_TABLES,
  instituteIdTables,
  isSensitiveColumn,
  tableNameOf,
  tenantTablePlan,
  UNREGISTERED_INSTITUTE_TABLES,
} from '../src/modules/tenant-data/catalog';
import { runTenantDataSweep, startDuePurges } from '../src/modules/tenant-data/deletion.service';
import { crc32 } from '../src/modules/tenant-data/zip-writer';
import { bearer, getApp, login, purgeRows, USERS } from './helpers';

const RUN = Date.now().toString(36);
const STARTED_AT = new Date(Date.now() - 1000);
/** Raw-query replacements format Dates in the process's local zone; the DB stores UTC. */
const utc = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const PASSWORD = 'Password@123';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TD = '/api/tenant-data';
const ADMIN_TD = '/api/admin/tenant-data';
let seq = Math.floor(Math.random() * 900_000);
/** 9423… is this suite's mobile range. */
const mobile = () => `9423${String(seq++ % 1_000_000).padStart(6, '0')}`;

interface Tenant {
  id: number;
  slug: string;
  token: string;
  adminId: number;
}

let sa: string;
let A: Tenant;
let B: Tenant;
let branchLimited: { id: number; token: string };
let sharedUserId: number;
let uploaded: { id: number; key: string; content: string };
let exportA: { id: number; key: string };
const userIds: number[] = [];
const invoiceIds: number[] = [];

const query = <T extends object>(sql: string, replacements: unknown[] = []) =>
  getSequelize().query<T>(sql, { replacements, type: QueryTypes.SELECT });

const send = async (method: 'get' | 'post' | 'delete', url: string, token: string | null, body?: object) => {
  const req = request(await getApp())[method](url);
  if (token) req.set(bearer(token));
  return body === undefined ? req : req.send(body);
};
const get = (url: string, token: string | null = sa) => send('get', url, token);
const post = (url: string, body: object = {}, token: string | null = sa) => send('post', url, token, body);
const del = (url: string, token: string | null = sa) => send('delete', url, token);

const download = async (url: string) =>
  request(await getApp())
    .get(new URL(url).pathname)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

/** Reads every entry of a (non-ZIP64) archive, checking each entry's CRC. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(data), name).toBe(crc);
    entries.set(name, data);
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

async function createInstitute(label: string): Promise<Tenant> {
  const [plan] = await query<{ id: number }>("SELECT id FROM plans WHERE code = 'starter'");
  const adminMobile = mobile();
  const slug = `td-${label}-${RUN}`;
  const res = await post('/api/admin/institutes', {
    name: `Tenant Data ${label.toUpperCase()}`,
    slug,
    planId: plan.id,
    state: 'Karnataka',
    admin: { name: `Admin ${label.toUpperCase()}`, mobile: adminMobile, password: PASSWORD },
  });
  expect(res.status).toBe(201);
  const [user] = await query<{ id: number }>('SELECT id FROM users WHERE mobile = ?', [adminMobile]);
  userIds.push(user.id);
  const token = (await login({ mobile: adminMobile, password: PASSWORD })).accessToken;
  return { id: res.body.id, slug, token, adminId: user.id };
}

async function addMember(t: Tenant, roleSlug: string, memberMobile: string, branchId: number | null) {
  const roles = (await get('/api/roles', t.token)).body as { id: number; slug: string }[];
  const role = roles.find((r) => r.slug === roleSlug)!;
  const res = await post(
    '/api/users',
    {
      name: `Member ${roleSlug}`,
      mobile: memberMobile,
      password: PASSWORD,
      roles: [{ roleId: role.id, branchId }],
      branchIds: branchId ? [branchId] : [],
    },
    t.token,
  );
  expect(res.status).toBe(201);
  userIds.push(res.body.id);
  return res.body.id as number;
}

const institute = async (id: number) =>
  (await query<{ status: string }>('SELECT status FROM institutes WHERE id = ?', [id]))[0];

async function deletionAudit(requestId: number) {
  const rows = await query<{ action: string; institute_id: number | null; metadata: unknown }>(
    "SELECT action, institute_id, metadata FROM audit_events WHERE entity_type = 'institute_deletion_request' AND entity_id = ? ORDER BY id",
    [String(requestId)],
  );
  return rows.map((r) => ({ action: r.action, instituteId: r.institute_id, metadata: json(r.metadata) }));
}

const auditActions = async (instituteId: number, entityType: string, entityId: number) =>
  (
    await query<{ action: string }>(
      'SELECT action FROM audit_events WHERE institute_id = ? AND entity_type = ? AND entity_id = ? ORDER BY id',
      [instituteId, entityType, String(entityId)],
    )
  ).map((r) => r.action);

/** Purge tables that still hold rows of the institute. */
async function tablesWithRows(instituteId: number) {
  const left: string[] = [];
  for (const t of (await tenantTablePlan()).filter((p) => p.purge)) {
    const [row] = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${t.table}\` WHERE institute_id = ?`,
      [instituteId],
    );
    if (Number(row.n)) left.push(t.table);
  }
  return left;
}

beforeAll(async () => {
  sa = (await login(USERS.superAdmin)).accessToken;
  A = await createInstitute('a');
  B = await createInstitute('b');
  const branches = (await get('/api/branches', A.token)).body as { id: number }[];
  const blMobile = mobile();
  branchLimited = { id: await addMember(A, 'branch-admin', blMobile, branches[0].id), token: '' };
  branchLimited.token = (await login({ mobile: blMobile, password: PASSWORD })).accessToken;
  // One account that belongs to both institutes.
  const sharedMobile = mobile();
  sharedUserId = await addMember(A, 'teacher', sharedMobile, null);
  expect(await addMember(B, 'teacher', sharedMobile, null)).toBe(sharedUserId);
});

afterAll(async () => {
  const sequelize = getSequelize();
  const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
  const instituteIds = [A?.id, B?.id].filter((x): x is number => !!x);
  if (instituteIds.length) {
    // SaaS billing documents outlive a deleted institute (institute_id → NULL), so go by id.
    const invoices = [
      ...invoiceIds,
      ...ids(await query('SELECT id FROM subscription_invoices WHERE institute_id IN (?)', [instituteIds])),
    ];
    if (invoices.length) {
      await sequelize.query('DELETE FROM subscription_payments WHERE invoice_id IN (?)', {
        replacements: [invoices],
      });
      await purgeRows('subscription_invoices', invoices);
    }
    for (const id of instituteIds) {
      await getStorage().deletePrefix(`institutes/${id}/`);
      if (!(await institute(id))) continue;
      await sequelize.query('DELETE FROM subscription_payments WHERE institute_id = ?', {
        replacements: [id],
      });
      await sequelize.query('DELETE FROM audit_events WHERE institute_id = ?', { replacements: [id] });
      await purgeRows('institutes', [id]);
    }
    const requests = ids(
      await query('SELECT id FROM institute_deletion_requests WHERE institute_ref_id IN (?)', [instituteIds]),
    );
    if (requests.length) {
      await sequelize.query(
        "DELETE FROM audit_events WHERE entity_type = 'institute_deletion_request' AND entity_id IN (?)",
        { replacements: [requests.map(String)] },
      );
      await purgeRows('institute_deletion_requests', requests);
    }
  }
  await sequelize.query("DELETE FROM jobs WHERE name = 'tenant-data.purge' AND created_at >= ?", {
    replacements: [utc(STARTED_AT)],
  });
  await purgeRows('users', [
    ...userIds,
    ...ids(await query("SELECT id FROM users WHERE mobile LIKE '9423%'")),
  ]);
});

describe('tenant table catalogue', () => {
  it('covers every table that has an institute_id', async () => {
    const tables = await instituteIdTables();
    const registered = listTenantModels().map((e) => tableNameOf(e.model));
    expect(registered.length).toBeGreaterThan(50);
    // A registered model without the column would be skipped by export and deletion.
    expect(registered.filter((t) => !tables.includes(t))).toEqual([]);
    // A table nobody declared fails here: register its model with registerTenantModel (or, for
    // platform bookkeeping, catalogue it in UNREGISTERED_INSTITUTE_TABLES).
    expect(tables.filter((t) => !registered.includes(t) && !(t in UNREGISTERED_INSTITUTE_TABLES))).toEqual(
      [],
    );
    // No stale or doubled catalogue entries.
    expect(
      Object.keys(UNREGISTERED_INSTITUTE_TABLES).filter((t) => !tables.includes(t) || registered.includes(t)),
    ).toEqual([]);
    expect([...EXPORT_EXCLUDED_TABLES].filter((t) => !registered.includes(t))).toEqual([]);

    const plan = await tenantTablePlan();
    expect(plan.map((t) => t.table)).toEqual(tables);
    expect(plan.filter((t) => t.reason === 'Uncatalogued tenant table')).toEqual([]);
    expect(
      plan
        .filter((t) => !t.purge)
        .map((t) => t.table)
        .sort(),
    ).toEqual([
      'institute_deletion_requests',
      'subscription_credit_notes',
      'subscription_invoices',
      'subscription_payments',
    ]);
    // Final-wave tables: tenant/personal data is purged; transient report downloads are not exported.
    const rule = (table: string) => {
      const t = plan.find((p) => p.table === table);
      return t && { export: t.export, purge: t.purge };
    };
    expect(rule('exam_mark_revisions')).toEqual({ export: true, purge: true });
    expect(rule('fee_course_enrolments')).toEqual({ export: true, purge: true });
    expect(rule('ai_usage')).toEqual({ export: true, purge: true });
    expect(rule('report_exports')).toEqual({ export: false, purge: true });
  });

  it('never exports credentials', () => {
    expect(isSensitiveColumn('users', 'password_hash')).toBe(true);
    expect(isSensitiveColumn('refresh_tokens', 'token_hash')).toBe(true);
    expect(isSensitiveColumn('notification_providers', 'secrets_encrypted')).toBe(true);
    expect(isSensitiveColumn('payment_gateway_configs', 'webhook_key')).toBe(true);
    expect(isSensitiveColumn('lms_offline_licenses', 'content_key')).toBe(true);
    expect(isSensitiveColumn('devices', 'unlock_key_hash')).toBe(true);
    expect(isSensitiveColumn('users', 'mobile')).toBe(false);
    expect(isSensitiveColumn('fee_receipts', 'tokenized')).toBe(false);
  });
});

describe('institute data export', () => {
  it('is only for institute-wide administrators', async () => {
    expect((await get(`${TD}/exports`, null)).status).toBe(401);
    for (const res of [
      await get(`${TD}/exports`, branchLimited.token),
      await post(`${TD}/exports`, {}, branchLimited.token),
      await post(`${TD}/deletion-request`, { confirm: A.slug }, branchLimited.token),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSTITUTE_WIDE_ACCESS_REQUIRED');
    }
    expect((await get(`${ADMIN_TD}/deletion-requests`, A.token)).status).toBe(403);
    expect((await post(`${ADMIN_TD}/institutes/${A.id}/exports`, {}, A.token)).status).toBe(403);
  });

  it('exports all institute data and media through a short-lived signed link', async () => {
    const content = `Export me ${RUN}`;
    const up = await request(await getApp())
      .post('/api/files')
      .set(bearer(A.token))
      .field('module', 'general')
      .attach('file', Buffer.from(content), { filename: 'export-note.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);
    const [file] = await query<{ storage_key: string }>('SELECT storage_key FROM files WHERE id = ?', [
      up.body.id,
    ]);
    uploaded = { id: up.body.id, key: file.storage_key, content };

    const created = await post(`${TD}/exports`, {}, A.token);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ instituteId: A.id, status: 'pending', includeMedia: true });
    const again = await post(`${TD}/exports`, { includeMedia: false }, A.token);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EXPORT_IN_PROGRESS');
    const early = await post(`${TD}/exports/${created.body.id}/link`, {}, A.token);
    expect(early.body.error.code).toBe('EXPORT_NOT_READY');

    await processDueJobs(200);
    const list = await get(`${TD}/exports`, A.token);
    expect(list.status).toBe(200);
    const ready = list.body.find((e: { id: number }) => e.id === created.body.id);
    expect(ready).toMatchObject({ status: 'ready', fileCount: 1, error: null });
    expect(ready.rowCount).toBeGreaterThan(5);
    expect(ready.sizeBytes).toBeGreaterThan(0);
    expect(Date.parse(ready.expiresAt) - Date.now()).toBeGreaterThan(7 * DAY - HOUR);
    expect(Date.parse(ready.expiresAt) - Date.now()).toBeLessThanOrEqual(7 * DAY);
    const [row] = await query<{ storage_key: string }>('SELECT storage_key FROM data_exports WHERE id = ?', [
      ready.id,
    ]);
    expect(row.storage_key.startsWith(`institutes/${A.id}/exports/`)).toBe(true);
    exportA = { id: ready.id, key: row.storage_key };

    const link = await post(`${TD}/exports/${ready.id}/link`, {}, A.token);
    expect(link.status).toBe(200);
    const ttl = Date.parse(link.body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600_000);

    const res = await download(link.body.url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`filename="${A.slug}-export-\\d{4}-\\d{2}-\\d{2}\\.zip"`),
    );
    const archive = res.body as Buffer;
    expect(archive.length).toBe(ready.sizeBytes);
    const entries = unzip(archive);

    const manifest = JSON.parse(entries.get('manifest.json')!.toString());
    expect(manifest).toMatchObject({
      format: 'erp-coaching-institute-export',
      version: 1,
      exportId: ready.id,
      institute: { id: A.id, slug: A.slug },
      media: { included: true, files: 1, missingFileIds: [] },
    });
    expect(JSON.parse(entries.get('institute.json')!.toString())).toMatchObject({ id: A.id, slug: A.slug });
    expect(entries.get(`media/${uploaded.id}/export-note.txt`)?.toString()).toBe(content);

    const notExported = manifest.notExported.map((t: { name: string }) => t.name);
    expect(notExported).toEqual(
      expect.arrayContaining(['data_exports', 'institute_deletion_requests', 'jobs', 'refresh_tokens']),
    );
    const tables = manifest.tables as { name: string; rows: number; files: string[] }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['branches', 'files', 'subscriptions', 'user_roles', 'users', 'audit_events']),
    );
    expect(tables.filter((t) => notExported.includes(t.name))).toEqual([]);
    expect(tables.reduce((n, t) => n + t.rows, 0)).toBe(ready.rowCount);

    const hash = (
      await query<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', [A.adminId])
    )[0].h;
    expect(hash).toBeTruthy();
    for (const t of tables) {
      expect(t.files).toEqual([`data/${t.name}.json`, `csv/${t.name}.csv`]);
      const rows = JSON.parse(entries.get(`data/${t.name}.json`)!.toString()) as Record<string, unknown>[];
      expect(rows.length, t.name).toBe(t.rows);
      for (const r of rows) {
        expect(
          Object.keys(r).filter((c) => isSensitiveColumn(t.name, c)),
          t.name,
        ).toEqual([]);
        if ('institute_id' in r) expect(Number(r.institute_id), t.name).toBe(A.id);
      }
      const header = entries.get(`csv/${t.name}.csv`)!.toString().split('\r\n')[0];
      expect(
        header.split(',').filter((c) => isSensitiveColumn(t.name, c)),
        t.name,
      ).toEqual([]);
    }
    for (const [name, data] of entries) expect(data.includes(hash), name).toBe(false);

    const users = JSON.parse(entries.get('data/users.json')!.toString()) as { id: number }[];
    const userIdsInExport = users.map((u) => Number(u.id));
    expect(userIdsInExport).toEqual(expect.arrayContaining([A.adminId, branchLimited.id, sharedUserId]));
    expect(users.every((u) => !('is_super_admin' in u))).toBe(true);
    const superAdmins = await query<{ id: number }>('SELECT id FROM users WHERE is_super_admin = 1');
    expect(superAdmins.filter((s) => userIdsInExport.includes(Number(s.id)))).toEqual([]);

    const token: string = link.body.url.split('/').pop();
    const forged = `${token[0] === 'x' ? 'y' : 'x'}${token.slice(1)}`;
    expect((await download(link.body.url.replace(token, forged))).status).toBe(404);
    expect(await auditActions(A.id, 'data_export', ready.id)).toEqual([
      'tenant_data.export_requested',
      'tenant_data.export_link_created',
      'tenant_data.export_downloaded',
    ]);
  }, 60_000);

  it("keeps an institute's exports private to it", async () => {
    expect((await post(`${TD}/exports/${exportA.id}/link`, {}, B.token)).status).toBe(404);
    expect((await del(`${TD}/exports/${exportA.id}`, B.token)).status).toBe(404);
    const list = await get(`${TD}/exports`, B.token);
    expect(list.body.map((e: { id: number }) => e.id)).not.toContain(exportA.id);
    expect((await post(`${ADMIN_TD}/institutes/${B.id}/exports/${exportA.id}/link`)).status).toBe(404);
    expect(await getStorage().stat(exportA.key)).not.toBeNull();
  });

  it('lets the super admin export an institute and delete the archive', async () => {
    const created = await post(`${ADMIN_TD}/institutes/${B.id}/exports`, { includeMedia: false });
    expect(created.status).toBe(201);
    await processDueJobs(200);
    const list = await get(`${ADMIN_TD}/institutes/${B.id}/exports`);
    const ready = list.body.find((e: { id: number }) => e.id === created.body.id);
    expect(ready).toMatchObject({ status: 'ready', includeMedia: false, fileCount: 0 });

    const link = await post(`${ADMIN_TD}/institutes/${B.id}/exports/${ready.id}/link`);
    expect(link.status).toBe(200);
    const res = await download(link.body.url);
    expect(res.status).toBe(200);
    const manifest = JSON.parse(
      unzip(res.body as Buffer)
        .get('manifest.json')!
        .toString(),
    );
    expect(manifest.institute.id).toBe(B.id);
    expect(manifest.media).toMatchObject({ included: false, files: 0 });

    const [row] = await query<{ storage_key: string }>('SELECT storage_key FROM data_exports WHERE id = ?', [
      ready.id,
    ]);
    expect(await getStorage().stat(row.storage_key)).not.toBeNull();
    expect((await del(`${ADMIN_TD}/institutes/${B.id}/exports/${ready.id}`)).status).toBe(204);
    expect(await getStorage().stat(row.storage_key)).toBeNull();
    expect((await download(link.body.url)).status).toBe(404);
    expect(await query('SELECT id FROM data_exports WHERE id = ?', [ready.id])).toEqual([]);
  }, 60_000);
});

describe('institute deletion', () => {
  it('needs the institute code and can be withdrawn by the institute', async () => {
    const wrong = await post(`${TD}/deletion-request`, { confirm: 'not-the-code' }, B.token);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CONFIRMATION_MISMATCH');

    const created = await post(
      `${TD}/deletion-request`,
      { confirm: B.slug.toUpperCase(), reason: 'Closing down' },
      B.token,
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      instituteId: B.id,
      instituteSlug: B.slug,
      status: 'pending',
      reason: 'Closing down',
      requestedBy: B.adminId,
    });
    const twice = await post(`${TD}/deletion-request`, { confirm: B.slug }, B.token);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('DELETION_REQUEST_OPEN');
    expect((await get(`${TD}/deletion-request`, B.token)).body.request.id).toBe(created.body.id);
    // Only platform staff decide.
    expect((await post(`${ADMIN_TD}/deletion-requests/${created.body.id}/approve`, {}, B.token)).status).toBe(
      403,
    );

    const cancelled = await post(`${TD}/deletion-request/cancel`, {}, B.token);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await post(`${TD}/deletion-request/cancel`, {}, B.token)).status).toBe(404);
    expect((await deletionAudit(created.body.id)).map((a) => a.action)).toEqual([
      'institute.deletion_requested',
      'institute.deletion_cancelled',
    ]);
    expect((await institute(B.id)).status).toBe('active');
  });

  it('lets the super admin reject, approve and cancel requests', async () => {
    const first = await post(`${TD}/deletion-request`, { confirm: B.slug }, B.token);
    const rejected = await post(`${ADMIN_TD}/deletion-requests/${first.body.id}/reject`, {
      note: 'Outstanding dues',
    });
    expect(rejected.body).toMatchObject({ status: 'rejected', decisionNote: 'Outstanding dues' });
    const again = await post(`${ADMIN_TD}/deletion-requests/${first.body.id}/approve`, { graceDays: 0 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DELETION_REQUEST_STATE');

    // Raised by support on the institute's behalf.
    const second = await post(`${ADMIN_TD}/institutes/${B.id}/deletion-request`, { confirm: B.slug });
    expect(second.status).toBe(201);
    const approved = await post(`${ADMIN_TD}/deletion-requests/${second.body.id}/approve`, {
      graceDays: 30,
      note: 'Confirmed by phone',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(Math.abs(Date.parse(approved.body.scheduledFor) - Date.now() - 30 * DAY)).toBeLessThan(HOUR);
    expect((await institute(B.id)).status).toBe('inactive');
    const listed = await get(`${ADMIN_TD}/deletion-requests?status=approved`);
    expect(listed.body.items.map((r: { id: number }) => r.id)).toContain(second.body.id);
    expect((await get(`${ADMIN_TD}/institutes/${B.id}/deletion-request`)).body.request.id).toBe(
      second.body.id,
    );

    // Nothing happens before the grace period ends.
    await startDuePurges(new Date());
    expect((await get(`${ADMIN_TD}/institutes/${B.id}/deletion-request`)).body.request.status).toBe(
      'approved',
    );

    const cancelled = await post(`${ADMIN_TD}/deletion-requests/${second.body.id}/cancel`, {
      note: 'Changed their mind',
    });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', decisionNote: 'Changed their mind' });
    expect((await institute(B.id)).status).toBe('active');

    const trail = await deletionAudit(second.body.id);
    expect(trail.map((a) => a.action)).toEqual([
      'institute.deletion_requested',
      'institute.deletion_approved',
      'institute.deletion_cancelled',
    ]);
    expect(trail.every((a) => a.instituteId === null && a.metadata.instituteId === B.id)).toBe(true);
    expect(trail[1].metadata).toMatchObject({ graceDays: 30, note: 'Confirmed by phone' });
    expect(trail[2].metadata).toMatchObject({ by: 'platform', restoredStatus: 'active' });
    expect((await deletionAudit(first.body.id)).map((a) => a.action)).toEqual([
      'institute.deletion_requested',
      'institute.deletion_rejected',
    ]);
  });

  it('does not delete an institute that was reactivated during the grace period', async () => {
    const created = await post(`${ADMIN_TD}/institutes/${B.id}/deletion-request`, { confirm: B.slug });
    await post(`${ADMIN_TD}/deletion-requests/${created.body.id}/approve`, { graceDays: 1 });
    expect((await institute(B.id)).status).toBe('inactive');
    expect((await post(`/api/admin/institutes/${B.id}/status`, { status: 'active' })).status).toBe(200);

    expect(await startDuePurges(new Date(Date.now() + 2 * DAY))).toBe(0);
    const latest = (await get(`${ADMIN_TD}/institutes/${B.id}/deletion-request`)).body.request;
    expect(latest).toMatchObject({
      id: created.body.id,
      status: 'cancelled',
      decisionNote: 'Cancelled: the institute was reactivated',
    });
    expect((await deletionAudit(created.body.id)).at(-1)).toMatchObject({
      action: 'institute.deletion_cancelled',
      metadata: { by: 'reactivation' },
    });
  });

  it('permanently deletes every tenant row and file once approved', async () => {
    // A SaaS invoice and its payment are the operator's records and must survive the deletion.
    const invoice = await post('/api/admin/billing/invoices', {
      instituteId: A.id,
      lines: [{ description: 'Data migration', unitPricePaise: 250_000 }],
    });
    expect(invoice.status).toBe(201);
    invoiceIds.push(invoice.body.id);
    const paid = await post(`/api/admin/billing/invoices/${invoice.body.id}/payments`, {
      amountPaise: invoice.body.totalPaise,
      reference: 'NEFT-TD',
    });
    expect(paid.status).toBe(201);

    const before = await tablesWithRows(A.id);
    expect(before).toEqual(
      expect.arrayContaining([
        'audit_events',
        'branches',
        'data_exports',
        'files',
        'subscriptions',
        'user_roles',
      ]),
    );
    expect(await getStorage().stat(uploaded.key)).not.toBeNull();

    const requested = await post(`${TD}/deletion-request`, { confirm: A.slug, reason: 'Moving on' }, A.token);
    expect(requested.status).toBe(201);
    const approved = await post(`${ADMIN_TD}/deletion-requests/${requested.body.id}/approve`, {
      graceDays: 0,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('purging');
    const blocked = await post(`${ADMIN_TD}/institutes/${A.id}/exports`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INSTITUTE_DELETION_IN_PROGRESS');

    await processDueJobs(200);
    const done = (await get(`${ADMIN_TD}/deletion-requests?status=completed`)).body.items.find(
      (r: { id: number }) => r.id === requested.body.id,
    );
    expect(done).toMatchObject({
      instituteId: null,
      instituteName: 'Tenant Data A',
      instituteSlug: A.slug,
      status: 'completed',
      error: null,
      requestedBy: null, // the requester's account is gone; requestedByName stays
      requestedByName: 'Admin A',
    });
    expect(Object.keys(done.summary.tables)).toEqual(expect.arrayContaining(before));
    expect(done.summary.files).toBeGreaterThanOrEqual(2); // the upload and the export archive
    expect(done.summary.users).toBe(2);
    expect(done.summary.anonymizedUsers).toBe(0);
    expect(done.summary.retainedTables.sort()).toEqual(['subscription_invoices', 'subscription_payments']);

    expect(await tablesWithRows(A.id)).toEqual([]);
    expect(await institute(A.id)).toBeUndefined();
    expect(await getStorage().stat(uploaded.key)).toBeNull();
    expect(await getStorage().stat(exportA.key)).toBeNull();
    expect(fs.existsSync(path.join(config.storageLocalRoot, 'institutes', String(A.id)))).toBe(false);

    // Its own users are deleted; an account that also belongs to another institute stays.
    expect(await query('SELECT id FROM users WHERE id IN (?)', [[A.adminId, branchLimited.id]])).toEqual([]);
    expect(
      await query<{ institute_id: number }>(
        'SELECT DISTINCT institute_id FROM user_roles WHERE user_id = ?',
        [sharedUserId],
      ),
    ).toEqual([{ institute_id: B.id }]);

    // Operator records are kept, detached from the institute.
    expect(
      await query('SELECT institute_id FROM subscription_invoices WHERE id = ?', [invoice.body.id]),
    ).toEqual([{ institute_id: null }]);
    expect(
      await query('SELECT institute_id FROM subscription_payments WHERE invoice_id = ?', [invoice.body.id]),
    ).toEqual([{ institute_id: null }]);

    const trail = await deletionAudit(requested.body.id);
    expect(trail.map((a) => a.action)).toEqual([
      'institute.deletion_requested',
      'institute.deletion_approved',
      'institute.purge_started',
      'institute.purged',
    ]);
    expect(trail.at(-1)?.metadata).toMatchObject({ instituteId: A.id, users: 2, files: done.summary.files });
    expect(await query('SELECT id FROM audit_events WHERE institute_id = ?', [A.id])).toEqual([]);
    expect((await post(`${ADMIN_TD}/deletion-requests/${requested.body.id}/retry`)).status).toBe(409);
  }, 60_000);

  it('fails a stuck purge and finishes it on retry', async () => {
    const created = await post(`${ADMIN_TD}/institutes/${B.id}/deletion-request`, { confirm: B.slug });
    const approved = await post(`${ADMIN_TD}/deletion-requests/${created.body.id}/approve`, { graceDays: 0 });
    expect(approved.body.status).toBe('purging');

    // The worker died: the sweep flags the purge and its queued job no longer runs it.
    const sweep = await runTenantDataSweep(new Date(Date.now() + 13 * HOUR));
    expect(sweep.stuckPurges).toBe(1);
    expect(sweep.purgesStarted).toBe(0);
    await processDueJobs(200);
    const failed = (await get(`${ADMIN_TD}/deletion-requests?status=failed`)).body.items.find(
      (r: { id: number }) => r.id === created.body.id,
    );
    expect(failed.error).toMatch(/did not finish/);
    expect((await institute(B.id)).status).toBe('inactive');

    const retried = await post(`${ADMIN_TD}/deletion-requests/${created.body.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('purging');
    await processDueJobs(200);
    const done = (await get(`${ADMIN_TD}/institutes/${B.id}/deletion-request`)).status;
    expect(done).toBe(404); // the institute no longer exists
    const [row] = await query<{ status: string; institute_id: number | null }>(
      'SELECT status, institute_id FROM institute_deletion_requests WHERE id = ?',
      [created.body.id],
    );
    expect(row).toEqual({ status: 'completed', institute_id: null });
    expect(await tablesWithRows(B.id)).toEqual([]);
    // The account shared with the first institute has no membership left now.
    expect(await query('SELECT id FROM users WHERE id IN (?)', [[B.adminId, sharedUserId]])).toEqual([]);
    expect((await deletionAudit(created.body.id)).map((a) => a.action)).toEqual([
      'institute.deletion_requested',
      'institute.deletion_approved',
      'institute.purge_started',
      'institute.deletion_retried',
      'institute.purge_started',
      'institute.purged',
    ]);
  }, 60_000);
});
