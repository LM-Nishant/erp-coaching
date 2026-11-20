import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Model, QueryTypes } from 'sequelize';
import { vi } from 'vitest';
import { getSequelize } from '../../src/infrastructure/database/sequelize';
import { logger } from '../../src/infrastructure/logger';
import { getContext } from '../../src/shared/context';
import { User } from '../../src/modules/users/user.model';
import { bearer, getApp, lastOtpFor, login, purgeRows, stableDevice } from '../helpers';

/**
 * Fixtures and helpers for the authorization / tenant-isolation suite. Every user created here has
 * a 945… mobile (see CONTRIBUTING.md › Tests) and everything is purged in `afterAll`.
 */
export const PASSWORD = 'Isolation@12345';

export interface Actor {
  /** Label used in failure messages. */
  label: string;
  userId: number;
  mobile: string;
  token: string;
}

export interface Tenant {
  id: number;
  slug: string;
  admin: Actor;
  mainBranchId: number;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Who = Actor | string | null;

export async function query<T extends object>(sql: string, replacements?: unknown): Promise<T[]> {
  await getApp();
  return getSequelize().query<T>(sql, {
    type: QueryTypes.SELECT,
    replacements: replacements as Record<string, unknown> | unknown[] | undefined,
  });
}

let serverError = '';
let capturing = false;

/**
 * Records the error behind the last 5xx (the error handler logs it; the logger is silent in tests),
 * so failure reports can say why a probe crashed instead of just "500".
 */
function captureServerErrors() {
  if (capturing) return;
  capturing = true;
  const original = logger.error.bind(logger);
  vi.spyOn(logger, 'error').mockImplementation(((obj: unknown, ...rest: unknown[]) => {
    const err = (obj as { err?: unknown } | null)?.err;
    if (err instanceof Error) {
      const frame = err.stack?.split('\n').find((l) => l.includes('/src/') && !l.includes('node_modules'));
      serverError = `${err.message.split('\n')[0]}${frame ? ` @ ${frame.trim().replace(/^at /, '')}` : ''}`;
    }
    return (original as (...a: unknown[]) => void)(obj, ...rest);
  }) as typeof logger.error);
}

/** Why the last request sent with `send` answered 5xx (empty when it did not, or nothing was logged). */
export const lastServerError = () => serverError;

/** Sends one API request as `who` (an actor, a raw token or anonymous). JSON body for writes. */
export async function send(
  who: Who,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  captureServerErrors();
  serverError = '';
  const m = method.toLowerCase() as Method;
  let req = request(await getApp())[m](url);
  const token = typeof who === 'string' ? who : who?.token;
  if (token) req = req.set(bearer(token));
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  if (body !== undefined && m !== 'get') req = req.send(body as object);
  return req;
}

/** `send`, but throws with the response unless it is 2xx. Returns the parsed body. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ok(who: Who, method: string, url: string, body?: unknown): Promise<any> {
  const res = await send(who, method, url, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method.toUpperCase()} ${url} → ${res.status}: ${res.text.slice(0, 600)}`);
  }
  return res.body;
}

/** Uploads one file (multipart field `file`, plus form `fields`) as `who`; throws unless 2xx. */
export async function upload(
  who: Actor,
  url: string,
  file: { name: string; type: string; data: Buffer },
  fields: Record<string, string> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  let req = request(await getApp())
    .post(url)
    .set(bearer(who.token));
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  const res = await req.attach('file', file.data, { filename: file.name, contentType: file.type });
  if (res.status < 200 || res.status >= 300)
    throw new Error(`POST ${url} (upload) → ${res.status}: ${res.text}`);
  return res.body;
}

/** Unique 10-digit 945… mobiles; `area` (1–2 digits) keeps test files from colliding. */
export function mobileFactory(area: string) {
  let n = 0;
  return () => `945${area}${String(n++).padStart(7 - area.length, '0')}`;
}

/** Random tag embedded in fixture names so leaks can be spotted in any response body. */
export const marker = (prefix: string) => `${prefix}${crypto.randomBytes(4).toString('hex')}`;

async function userIdOf(mobile: string): Promise<number> {
  const [row] = await query<{ id: number }>('SELECT id FROM users WHERE mobile = ?', [mobile]);
  if (!row) throw new Error(`No user with mobile ${mobile}`);
  return row.id;
}

/** Signs in with password (when given) or OTP, on a stable device so the device limit is never hit. */
export async function signIn(label: string, mobile: string, password?: string): Promise<Actor> {
  let token: string;
  if (password) {
    token = (await login({ mobile, password })).accessToken;
  } else {
    const app = await getApp();
    const device = stableDevice(mobile);
    const challenge = await request(app).post('/api/auth/otp/request').send({ mobile, device });
    if (!challenge.body.challengeId) throw new Error(`OTP request failed for ${mobile}: ${challenge.text}`);
    const res = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: challenge.body.challengeId, code: lastOtpFor(mobile), device });
    if (res.body.status !== 'authenticated') throw new Error(`OTP login failed for ${mobile}: ${res.text}`);
    token = res.body.accessToken;
  }
  return { label, userId: await userIdOf(mobile), mobile, token };
}

export async function createSuperAdmin(mobile: string): Promise<Actor> {
  await getApp(); // initialises the models
  await User.create({
    name: 'Isolation Super Admin',
    mobile,
    email: null,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    lastLoginAt: null,
    isSuperAdmin: true,
  });
  return signIn('super admin', mobile, PASSWORD);
}

/** A new institute (Growth plan, all modules, unless `planId`) with its own admin, via the platform API. */
export async function createInstitute(
  superAdmin: Actor,
  opts: { slug: string; name: string; adminMobile: string; label: string; planId?: number },
): Promise<Tenant> {
  const [growth] = await query<{ id: number }>("SELECT id FROM plans WHERE code = 'growth'");
  const institute = await ok(superAdmin, 'POST', '/api/admin/institutes', {
    name: opts.name,
    slug: opts.slug,
    planId: opts.planId ?? growth.id,
    admin: { name: `${opts.name} Admin`, mobile: opts.adminMobile, password: PASSWORD },
  });
  const [branch] = await query<{ id: number }>(
    'SELECT id FROM branches WHERE institute_id = ? ORDER BY id LIMIT 1',
    [institute.id],
  );
  return {
    id: institute.id,
    slug: opts.slug,
    mainBranchId: branch.id,
    admin: await signIn(opts.label, opts.adminMobile, PASSWORD),
  };
}

/** Staff user holding one custom role (institute-wide when `branchId` is null). */
export async function createStaff(
  admin: Actor,
  opts: { label: string; mobile: string; permissions: string[]; branchId: number | null },
): Promise<Actor> {
  const role = await ok(admin, 'POST', '/api/roles', {
    name: `Isolation ${opts.label} ${crypto.randomBytes(3).toString('hex')}`,
    permissions: opts.permissions,
  });
  await ok(admin, 'POST', '/api/users', {
    name: `Isolation ${opts.label}`,
    mobile: opts.mobile,
    password: PASSWORD,
    roles: [{ roleId: role.id, branchId: opts.branchId }],
    branchIds: opts.branchId ? [opts.branchId] : [],
  });
  return signIn(opts.label, opts.mobile, PASSWORD);
}

export async function allPermissionKeys(): Promise<string[]> {
  return (await query<{ key: string }>('SELECT `key` FROM permissions ORDER BY `key`')).map((p) => p.key);
}

/**
 * Removes institutes created by a suite and every row that belongs to them, plus the suite's users
 * (matched by mobile prefix). Nullable `institute_id` rows (audit, jobs, tokens, custom roles) are
 * deleted first: nulling them would turn custom roles into global ones.
 */
export async function purgeInstitutes(instituteIds: number[], mobilePrefix: string) {
  const sequelize = getSequelize();
  const ids = instituteIds.filter(Boolean);
  if (ids.length) {
    const nullable = await query<{ t: string }>(
      `SELECT TABLE_NAME AS t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'institute_id' AND IS_NULLABLE = 'YES'`,
    );
    for (const { t } of nullable) {
      if (t === 'roles') continue;
      await sequelize.query(`DELETE FROM \`${t}\` WHERE institute_id IN (?)`, { replacements: [ids] });
    }
    const roles = await query<{ id: number }>('SELECT id FROM roles WHERE institute_id IN (?)', [ids]);
    await purgeRows(
      'roles',
      roles.map((r) => r.id),
    );
    await purgeRows('institutes', ids);
  }
  const users = await query<{ id: number }>('SELECT id FROM users WHERE mobile LIKE ?', [`${mobilePrefix}%`]);
  await purgeRows(
    'users',
    users.map((u) => u.id),
  );
}

/**
 * Records every model row of another institute that is loaded while serving a request bound to an
 * institute. A handler that fetches a foreign row and only then answers 403/404/409 still reveals
 * that the row exists (and usually means the lookup was not tenant-scoped), so the crawlers treat
 * any such load as a failure regardless of the HTTP status. `includeSystem` also checks system
 * contexts bound to an institute (public website requests run that way).
 */
export function installTenantProbe(opts: { includeSystem?: boolean } = {}) {
  const violations: string[] = [];
  let label = '';
  const check = (value: unknown, depth: number, ctxInstitute: number) => {
    if (!value || depth > 3) return;
    if (Array.isArray(value)) {
      for (const v of value) check(v, depth, ctxInstitute);
      return;
    }
    if (typeof value !== 'object') return;
    const data = (value instanceof Model ? value.dataValues : value) as Record<string, unknown>;
    const owner = data.instituteId ?? data.institute_id;
    if (typeof owner === 'number' && owner !== ctxInstitute) {
      const name = value instanceof Model ? (value.constructor as typeof Model).name : 'row';
      violations.push(`${label}: loaded ${name}#${String(data.id)} of institute ${owner}`);
    }
    if (value instanceof Model) {
      for (const nested of Object.values(data)) {
        if (nested instanceof Model || (Array.isArray(nested) && nested[0] instanceof Model)) {
          check(nested, depth + 1, ctxInstitute);
        }
      }
    }
  };
  const hook = (result: unknown) => {
    const ctx = getContext();
    if (!label || !ctx.instituteId || ctx.isSuperAdmin || (ctx.system && !opts.includeSystem)) return;
    check(result, 0, ctx.instituteId);
  };
  getSequelize().addHook('afterFind', 'tenant-isolation-probe', hook);
  return {
    violations,
    /** Label for the requests about to be sent; empty disables the probe (e.g. during setup). */
    setLabel(value: string) {
      label = value;
    },
    remove: () => getSequelize().removeHook('afterFind', 'tenant-isolation-probe'),
  };
}

/** Tables never compared by `snapshotInstitute` (append-only side effects of any request). */
const SNAPSHOT_SKIP = new Set(['audit_events', 'jobs', 'refresh_tokens']);

/**
 * Columns left out of a table's checksum. `authenticate` records a device's activity (and Sequelize bumps
 * `updated_at` with it) at most once per ACTIVITY_TOUCH_INTERVAL_MS, so an attacker who is also a member of
 * the victim institute changes these on their own device once a run takes longer than that.
 */
const SNAPSHOT_SKIP_COLUMNS: Record<string, string[]> = {
  devices: ['last_seen_at', 'last_ip', 'updated_at'],
};

type Columns = Map<string, string[]>;
let columnsCache: Columns | null = null;
async function tableColumns(): Promise<Columns> {
  if (!columnsCache) {
    const rows = await query<{ t: string; c: string }>(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    );
    columnsCache = new Map();
    for (const { t, c } of rows) columnsCache.set(t, [...(columnsCache.get(t) ?? []), c]);
  }
  return columnsCache;
}

export async function tableNames(): Promise<Set<string>> {
  return new Set((await tableColumns()).keys());
}

export async function columnsOf(table: string): Promise<string[]> {
  return (await tableColumns()).get(table) ?? [];
}

export interface Snapshot {
  /** table → "count:checksum" over the institute's rows. */
  digest: Map<string, string>;
  /** table → highest id at snapshot time (for "existing rows only" comparisons). */
  maxId: Map<string, number>;
}

/**
 * Count + checksum of every row an institute owns (all columns), plus its members' user and device
 * rows. With `existingOnly`, rows created after `since` are ignored, so legitimate lazy inserts by
 * same-institute users do not count as changes while edits to existing rows still do.
 */
export async function snapshotInstitute(
  instituteId: number,
  opts: { since?: Snapshot; existingOnly?: boolean } = {},
): Promise<Snapshot> {
  const digest = new Map<string, string>();
  const maxId = new Map<string, number>();
  const id = Number(instituteId);
  const members = `(SELECT user_id FROM user_roles WHERE institute_id = ${id})`;
  const sources: { table: string; where: string }[] = [
    { table: 'institutes', where: `id = ${id}` },
    { table: 'users', where: `id IN ${members}` },
    { table: 'devices', where: `user_id IN ${members}` },
  ];
  for (const [table, cols] of await tableColumns()) {
    if (cols.includes('institute_id') && !SNAPSHOT_SKIP.has(table)) {
      sources.push({ table, where: `institute_id = ${id}` });
    }
  }
  for (const { table, where } of sources) {
    const cols = await columnsOf(table);
    const hasId = cols.includes('id');
    const limit = opts.existingOnly && hasId ? opts.since?.maxId.get(table) : undefined;
    const filter = limit !== undefined ? `${where} AND id <= ${limit}` : where;
    const skip = SNAPSHOT_SKIP_COLUMNS[table] ?? [];
    const list = cols
      .filter((c) => !skip.includes(c))
      .map((c) => `\`${c}\``)
      .join(', ');
    const [row] = await query<{ n: number; h: string | null; m: number | null }>(
      `SELECT COUNT(*) AS n, CAST(BIT_XOR(CRC32(CONCAT_WS('|', ${list}))) AS CHAR) AS h,
              ${hasId ? 'MAX(id)' : 'NULL'} AS m
         FROM \`${table}\` WHERE ${filter}`,
    );
    digest.set(table, `${row.n}:${row.h ?? 0}`);
    maxId.set(table, Number(row.m ?? 0));
  }
  return { digest, maxId };
}

export function snapshotChanges(before: Snapshot, after: Snapshot): string[] {
  const changed: string[] = [];
  for (const [table, value] of before.digest) {
    if (after.digest.get(table) !== value) changed.push(`${table} (${value} → ${after.digest.get(table)})`);
  }
  return changed;
}
