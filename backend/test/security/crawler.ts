import type { RouteInfo } from '../../src/infrastructure/route-registry';
import { routeParams } from '../../src/infrastructure/route-registry';
import { columnsOf, query, tableNames } from './harness';
import {
  NON_ID_PARAMS,
  PARAM_SQL,
  PARAM_TABLES,
  SEGMENT_TABLES,
  SELF_FAMILIES,
  TABLE_PREFIXES,
  USER_ROLE_HINTS,
} from './coverage';

/**
 * Turns a route from the registry into a concrete URL that points at a record of a chosen
 * institute (and optionally branch / owner), so the crawlers can probe every `/:id` route without
 * per-route test code. See CONTRIBUTING.md › "Authorization and tenant-isolation suite".
 */
export const routeKey = (r: Pick<RouteInfo, 'method' | 'path'>) => `${r.method} ${r.path}`;
export const isWrite = (r: Pick<RouteInfo, 'method'>) => r.method !== 'GET' && r.method !== 'HEAD';
export const idParamsOf = (path: string) => routeParams(path).filter((p) => !(p in NON_ID_PARAMS));

export type Family = (typeof SELF_FAMILIES)[number]['family'];

/** Self-service family of a route (its record belongs to the caller or the caller's child). */
export function selfFamily(path: string): Family | null {
  return SELF_FAMILIES.find((f) => f.pattern.test(path))?.family ?? null;
}

export interface Scope {
  instituteId: number;
  /** Only rows of this branch (directly, or through the parent record for nested routes). */
  branchId?: number;
  /** Portal crawl: columns that identify the owner (e.g. `student_user_id`) → owner's value. */
  ownerColumns?: Record<string, number>;
  /** Portal crawl: table → the owner's own row id (e.g. `students` → their student id). */
  ownerRows?: Record<string, number>;
  /** Values for non-id params (e.g. `site` for public website routes). */
  values?: Record<string, string>;
}

export interface Target {
  url: string;
  table: string;
  rowId: number | string;
}

export type Resolution = { target: Target; reason?: never } | { target?: never; reason: string };

/** Reason given for records that belong to no branch (the branch crawl does not apply). */
export const NO_BRANCH = 'has no branch (directly or via its parent)';

/** `/api/hr/employees/:id/contracts/:childId`, `childId` → `hr/employees/*\/contracts`. */
export function segmentKey(path: string, param: string): string {
  const segs = path.replace(/^\/api\//, '').split('/');
  const at = segs.findIndex((s) => s === `:${param}` || s === `*${param}`);
  return segs
    .slice(0, at)
    .map((s) => (s.startsWith(':') || s.startsWith('*') ? '*' : s))
    .join('/');
}

const snake = (s: string) => s.replace(/-/g, '_');
const singular = (s: string) => (s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.replace(/s$/, ''));

/** Table a route param points at: explicit maps first, then naming conventions. */
export async function tableFor(route: RouteInfo, param: string): Promise<string | null> {
  const key = segmentKey(route.path, param);
  if (SEGMENT_TABLES[key]) return SEGMENT_TABLES[key];
  if (PARAM_TABLES[param]) return PARAM_TABLES[param];
  const tables = await tableNames();
  const segs = key.split('/');
  const literal = snake(segs[segs.length - 1] ?? '');
  const parent =
    segs.length >= 3 && segs[segs.length - 2] === '*' ? singular(snake(segs[segs.length - 3])) : null;
  const prefixes = TABLE_PREFIXES[route.module] ?? [singular(snake(route.module))];
  const candidates = [
    ...(parent ? [`${parent}_${literal}`, ...prefixes.map((p) => `${p}_${parent}_${literal}`)] : []),
    literal,
    ...prefixes.map((p) => `${p}_${literal}`),
  ];
  for (const t of candidates) {
    if (tables.has(t) && (await columnsOf(t)).includes('id')) return t;
  }
  return null;
}

let fkCache: { table: string; column: string; target: string }[] | null = null;
/** First column of `child` with a foreign key to `parent`. */
export async function fkColumn(child: string, parent: string): Promise<string | null> {
  fkCache ??= await query<{ table: string; column: string; target: string }>(
    `SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`, REFERENCED_TABLE_NAME AS target
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_COLUMN_NAME = 'id'
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  return fkCache.find((f) => f.table === child && f.target === parent)?.column ?? null;
}

type Row = Record<string, unknown> & { id: number };

/** Users who belong to the institute and to no other (so another institute can never see them). */
const ONLY_MEMBERS = `u.id IN (SELECT user_id FROM user_roles WHERE institute_id = :v)
  AND u.id NOT IN (SELECT user_id FROM user_roles WHERE institute_id <> :v)`;

async function pickRow(
  table: string,
  scope: Scope,
  opts: { role?: string; parent?: { table: string; column: string } } = {},
): Promise<Row | null | 'no-branch'> {
  const r = { v: scope.instituteId, b: scope.branchId ?? null, role: opts.role ?? null };
  const own = scope.ownerRows?.[table];
  if (table === 'users' || table === 'devices') {
    const conds = [ONLY_MEMBERS];
    if (opts.role) {
      conds.push(`u.id IN (SELECT ur.user_id FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                   WHERE ur.institute_id = :v AND ro.slug = :role)`);
    }
    if (scope.branchId) {
      conds.push(`(u.id IN (SELECT user_id FROM students WHERE institute_id = :v AND branch_id = :b)
                OR u.id IN (SELECT user_id FROM user_roles WHERE institute_id = :v AND branch_id = :b)
                OR u.id IN (SELECT user_id FROM user_branches WHERE institute_id = :v AND branch_id = :b))`);
    }
    const ownerUser = scope.ownerRows?.users;
    if (ownerUser) conds.push(`u.id = ${Number(ownerUser)}`);
    const sql =
      table === 'users'
        ? `SELECT u.* FROM users u WHERE ${conds.join(' AND ')} ORDER BY u.id LIMIT 1`
        : `SELECT d.* FROM devices d JOIN users u ON u.id = d.user_id
            WHERE ${conds.join(' AND ')} ORDER BY d.id LIMIT 1`;
    return (await query<Row>(sql, r))[0] ?? null;
  }
  const cols = await columnsOf(table);
  if (!cols.includes('institute_id')) return null;
  const conds = ['t.institute_id = :v'];
  let join = '';
  if (scope.branchId) {
    if (cols.includes('branch_id')) conds.push('t.branch_id = :b');
    else if (opts.parent && (await columnsOf(opts.parent.table)).includes('branch_id')) {
      join = `JOIN \`${opts.parent.table}\` p ON p.id = t.\`${opts.parent.column}\``;
      conds.push('p.branch_id = :b');
    } else return 'no-branch';
  }
  if (own) conds.push(`t.id = ${Number(own)}`);
  for (const [column, value] of Object.entries(scope.ownerColumns ?? {})) {
    if (cols.includes(column)) conds.push(`t.\`${column}\` = ${Number(value)}`);
  }
  const sql = `SELECT t.* FROM \`${table}\` t ${join} WHERE ${conds.join(' AND ')} ORDER BY t.id LIMIT 1`;
  return (await query<Row>(sql, r))[0] ?? null;
}

function fill(path: string, values: Record<string, unknown>): string {
  return path.replace(/[:*]([A-Za-z_$][\w$]*)/g, (_m, name: string) =>
    encodeURIComponent(String(values[name])),
  );
}

/**
 * Picks a record of `scope.instituteId` for the route's last id param and derives the other id
 * params from that record's foreign keys (or runs the route's `PARAM_SQL`). Returns why not when
 * that is impossible, so the coverage report can say exactly what to add.
 */
export interface ResolveOptions {
  /**
   * Called when the scope has no row for the route; creates one (see victim-data.ts) and returns
   * null, or returns why it could not. `need` lists nullable foreign keys the URL is built from.
   */
  synthesize?: (table: string, scope: Scope, need: string[]) => Promise<string | null>;
}

export async function resolveTarget(
  route: RouteInfo,
  scope: Scope,
  opts: ResolveOptions = {},
): Promise<Resolution> {
  const params = routeParams(route.path);
  const values: Record<string, unknown> = {};
  for (const p of params) {
    if (p in NON_ID_PARAMS) values[p] = scope.values?.[p] ?? NON_ID_PARAMS[p];
  }
  const ids = params.filter((p) => !(p in NON_ID_PARAMS));
  const last = ids[ids.length - 1];
  const sqlKey = segmentKey(route.path, last);
  const custom = PARAM_SQL[sqlKey];
  if (custom) {
    const conds: string[] = [];
    if (scope.branchId) {
      if (!custom.branch) return { reason: `PARAM_SQL['${sqlKey}'] has no branchId column` };
      conds.push(`q.branchId = :b`);
    }
    for (const [column, value] of Object.entries(custom.owner ?? {})) {
      const v = scope.ownerColumns?.[value];
      if (v !== undefined) conds.push(`q.\`${column}\` = ${Number(v)}`);
    }
    const find = async () =>
      (
        await query<Record<string, unknown>>(
          `SELECT * FROM (${custom.sql}) q ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} LIMIT 1`,
          { v: scope.instituteId, b: scope.branchId ?? null },
        )
      )[0];
    let row = await find();
    if (!row && opts.synthesize) {
      const failed = await opts.synthesize(custom.table, scope, []);
      if (failed) return { reason: failed };
      row = await find();
    }
    if (!row) {
      return {
        reason: `PARAM_SQL['${sqlKey}'] found no row — add SYNTHESIS_HINTS or seed it in victim-data.ts`,
      };
    }
    return {
      target: {
        url: fill(route.path, { ...row, ...values }),
        table: custom.table,
        rowId: row[last] as number | string,
      },
    };
  }
  const table = await tableFor(route, last);
  if (!table) {
    return {
      reason: `cannot tell which table :${last} is — add SEGMENT_TABLES['${segmentKey(route.path, last)}'] or PARAM_SQL`,
    };
  }
  const parents: { param: string; table: string; column: string | null }[] = [];
  for (const p of ids.slice(0, -1)) {
    const parentTable = await tableFor(route, p);
    parents.push({
      param: p,
      table: parentTable ?? '?',
      column: parentTable ? await fkColumn(table, parentTable) : null,
    });
  }
  const missing = parents.find((p) => !p.column);
  if (missing) {
    return { reason: `cannot derive :${missing.param} from ${table} — add PARAM_SQL['${sqlKey}']` };
  }
  const role = USER_ROLE_HINTS[last] ?? USER_ROLE_HINTS[segmentKey(route.path, last)];
  const first = parents[0];
  const pick = () =>
    pickRow(table, scope, {
      role,
      parent: first?.column ? { table: first.table, column: first.column } : undefined,
    });
  let row = await pick();
  if (row === 'no-branch') return { reason: NO_BRANCH };
  if (!row && opts.synthesize) {
    const failed = await opts.synthesize(
      table,
      scope,
      parents.map((p) => p.column as string),
    );
    if (failed) return { reason: failed };
    row = await pick();
  }
  if (row === 'no-branch') return { reason: NO_BRANCH };
  if (!row) {
    const where = scope.branchId ? 'branch 2 of the victim institute' : 'the victim institute';
    return { reason: `no ${table} row in ${where} — create one in victim-data.ts` };
  }
  values[last] = row.id;
  for (const p of parents) values[p.param] = row[p.column as string];
  return { target: { url: fill(route.path, values), table, rowId: row.id } };
}

/** URL with sample values: `values`, else the `NON_ID_PARAMS` sample, else `1` for ids. */
export function sampleUrl(route: Pick<RouteInfo, 'path'>, values: Record<string, unknown> = {}): string {
  const all: Record<string, unknown> = {};
  for (const p of routeParams(route.path)) all[p] = values[p] ?? NON_ID_PARAMS[p] ?? 1;
  return fill(route.path, all);
}
