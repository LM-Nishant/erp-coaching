import { QueryTypes, type Transaction } from 'sequelize';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import { listTenantModels } from '../../shared/tenancy/tenant-model';

export interface TableRule {
  /** Included in the institute's data export. */
  export: boolean;
  /** Rows are deleted when the institute is permanently deleted (otherwise kept, detached). */
  purge: boolean;
  reason: string;
}

/**
 * Tables with an `institute_id` column that are not registered tenant models (platform bookkeeping
 * or tables written with raw SQL). Every such table must be listed here; a test fails otherwise.
 */
export const UNREGISTERED_INSTITUTE_TABLES: Readonly<Record<string, TableRule>> = {
  // Per-user AI calls with tokens and estimated provider cost (#19). The institute's copy, so it is
  // exported and purged; what the platform billed for AI lives on the retained SaaS invoices.
  ai_usage: { export: true, purge: true, reason: 'AI usage ledger (tokens and estimated cost)' },
  audit_events: { export: true, purge: true, reason: "The institute's audit trail" },
  fee_sequences: { export: true, purge: true, reason: 'Receipt numbering counters' },
  grievance_counters: { export: true, purge: true, reason: 'Ticket numbering counters' },
  roles: { export: true, purge: true, reason: 'Custom roles' },
  impersonation_sessions: { export: false, purge: true, reason: 'Platform support sessions' },
  jobs: { export: false, purge: true, reason: 'Background job queue' },
  refresh_tokens: { export: false, purge: true, reason: 'Login sessions (secrets)' },
  institute_deletion_requests: {
    export: false,
    purge: false,
    reason: 'Permanent record of the deletion itself',
  },
};

/** Registered tenant tables that are not part of the export archive. */
export const EXPORT_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  'data_exports',
  // Download links for generated report files that expire after 24 hours; `report.exported` audit
  // events (exported) already record who exported what.
  'report_exports',
]);

/** Secrets, credentials and hashes are never exported. */
const SENSITIVE_COLUMN = /(^|_)(password|secret|token)(_|$)|_(encrypted|hash)$/i;
const SENSITIVE_COLUMNS: ReadonlySet<string> = new Set([
  'payment_gateway_configs.webhook_key',
  'lms_offline_licenses.content_key', // encrypted offline-playback DRM key
  // Biometric unlock verifier (#17). `devices` is per user (no institute_id) and the `_hash` rule
  // already matches; listed so a rename can never leak it.
  'devices.unlock_key_hash',
]);

export const isSensitiveColumn = (table: string, column: string) =>
  SENSITIVE_COLUMN.test(column) || SENSITIVE_COLUMNS.has(`${table}.${column}`);

const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

/** Quotes a table/column name that came from information_schema (never from user input). */
export function ident(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`Unexpected identifier: ${name}`);
  return `\`${name}\``;
}

export interface TenantTable extends TableRule {
  table: string;
  /** Registered with `registerTenantModel`. */
  registered: boolean;
}

export const tableNameOf = (model: { getTableName(): string | { tableName: string } }) => {
  const t = model.getTableName();
  return typeof t === 'string' ? t : t.tableName;
};

/** Every base table of the current schema that has an `institute_id` column. */
export async function instituteIdTables(): Promise<string[]> {
  const rows = await getSequelize().query<{ t: string }>(
    `SELECT c.TABLE_NAME AS t FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES s ON s.TABLE_SCHEMA = c.TABLE_SCHEMA AND s.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'institute_id' AND s.TABLE_TYPE = 'BASE TABLE'
      ORDER BY c.TABLE_NAME`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.t);
}

/**
 * What happens to each institute-owned table on export and deletion. Registered tenant models are
 * exported and purged unless they opt into retention; tables nobody declared are still exported
 * and purged (and logged) so a missed registration never leaves tenant data behind.
 */
export async function tenantTablePlan(): Promise<TenantTable[]> {
  const registered = new Map(
    listTenantModels().map((e) => [tableNameOf(e.model), e.retainOnInstituteDeletion] as const),
  );
  const plan: TenantTable[] = [];
  for (const table of await instituteIdTables()) {
    ident(table);
    const retain = registered.get(table);
    const rule = UNREGISTERED_INSTITUTE_TABLES[table];
    if (retain !== undefined) {
      plan.push({
        table,
        registered: true,
        export: !EXPORT_EXCLUDED_TABLES.has(table),
        purge: !retain,
        reason: retain ? 'Retained operator record' : 'Tenant data',
      });
    } else if (rule) {
      plan.push({ table, registered: false, ...rule });
    } else {
      logger.warn({ table }, 'Table with institute_id is neither a registered tenant model nor catalogued');
      plan.push({ table, registered: false, export: true, purge: true, reason: 'Uncatalogued tenant table' });
    }
  }
  return plan;
}

/** Exportable columns per table, in table order (sensitive columns removed). */
export async function exportableColumns(tables: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>(tables.map((t) => [t, []]));
  if (!tables.length) return result;
  const rows = await getSequelize().query<{ t: string; c: string }>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    { type: QueryTypes.SELECT, replacements: { tables } },
  );
  for (const { t, c } of rows) {
    if (!SAFE_IDENTIFIER.test(c) || isSensitiveColumn(t, c)) continue;
    result.get(t)?.push(c);
  }
  return result;
}

export interface ForeignKeyEdge {
  table: string;
  column: string;
  referencedTable: string;
  deleteRule: string;
}

/** Foreign keys of the current schema. */
export async function foreignKeys(): Promise<ForeignKeyEdge[]> {
  return getSequelize().query<ForeignKeyEdge>(
    `SELECT k.TABLE_NAME AS \`table\`, k.COLUMN_NAME AS \`column\`,
            k.REFERENCED_TABLE_NAME AS referencedTable, r.DELETE_RULE AS deleteRule
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    { type: QueryTypes.SELECT },
  );
}

/** Columns of institute tables that point at `users` (members, authors, assignees, ...). */
export function userReferenceColumns(fks: ForeignKeyEdge[], instituteTables: Set<string>) {
  return fks.filter((f) => f.referencedTable === 'users' && instituteTables.has(f.table));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The given user ids minus super admins, ascending. */
export async function withoutSuperAdmins(ids: number[], transaction?: Transaction): Promise<number[]> {
  const result: number[] = [];
  for (const part of chunk([...new Set(ids)], 1000)) {
    const rows = await getSequelize().query<{ id: number }>(
      'SELECT id FROM users WHERE id IN (:ids) AND is_super_admin = 0',
      { type: QueryTypes.SELECT, replacements: { ids: part }, transaction },
    );
    result.push(...rows.map((r) => Number(r.id)));
  }
  return result.sort((a, b) => a - b);
}

/**
 * Users the institute's rows refer to (members, authors, assignees, ...), super admins excluded.
 * Tenant isolation means these are the institute's own users.
 */
export async function instituteUserIds(
  instituteId: number,
  tables: string[],
  fks: ForeignKeyEdge[],
  transaction?: Transaction,
): Promise<number[]> {
  const ids = new Set<number>();
  for (const f of userReferenceColumns(fks, new Set(tables))) {
    const col = ident(f.column);
    const rows = await getSequelize().query<{ u: number }>(
      `SELECT DISTINCT ${col} AS u FROM ${ident(f.table)} WHERE institute_id = :instituteId AND ${col} IS NOT NULL`,
      { type: QueryTypes.SELECT, replacements: { instituteId }, transaction },
    );
    for (const r of rows) ids.add(Number(r.u));
  }
  return withoutSuperAdmins([...ids], transaction);
}

/**
 * Child-first order for deleting the given tables: a table is deleted before every table it
 * references. Cycles (rare, usually nullable references) are appended in name order; the purge
 * retries tables a foreign key blocked.
 */
export function deletionOrder(tables: string[], fks: ForeignKeyEdge[]): string[] {
  const set = new Set(tables);
  // parent -> children still to delete; a parent can go once it has no remaining children.
  const children = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const f of fks) {
    if (f.table === f.referencedTable || !set.has(f.table) || !set.has(f.referencedTable)) continue;
    children.get(f.referencedTable)!.add(f.table);
  }
  const order: string[] = [];
  const done = new Set<string>();
  let progress = true;
  while (done.size < set.size && progress) {
    progress = false;
    for (const t of [...set].sort()) {
      if (done.has(t)) continue;
      if ([...children.get(t)!].every((c) => done.has(c))) {
        order.push(t);
        done.add(t);
        progress = true;
      }
    }
  }
  for (const t of [...set].sort()) if (!done.has(t)) order.push(t);
  return order;
}
