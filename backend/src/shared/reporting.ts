import { QueryTypes } from 'sequelize';
import { getSequelize } from '../infrastructure/database/sequelize';

/**
 * Scope and period handed to the `reporting.ts` query helpers that modules expose through their
 * `api.ts` for the reports module (spec §4.17).
 *
 * Helpers run aggregated raw SQL, which bypasses the tenant model hooks, so every query MUST filter
 * on `instituteId` and apply the narrowing below. The scope is explicit (no request context) so the
 * same helper runs in a request and in an export job. The reports module resolves and validates it
 * (branch access, guardian links, teacher batches) before calling a helper.
 */
export interface ReportScope {
  instituteId: number;
  /** Branches rows may belong to; null = every branch of the institute. */
  branchIds: number[] | null;
  courseId: number | null;
  batchId: number | null;
  /** Teacher audience: batches the teacher teaches; null = no restriction. */
  batchIds: number[] | null;
  /** Teacher audience: own classes, sessions, appointments; null = no restriction. */
  teacherUserId: number | null;
  /** Student/parent audience: students' login user ids; null = no restriction. */
  studentUserIds: number[] | null;
  /** Student/parent audience: `students.id` of the same students; null = no restriction. */
  studentIds: number[] | null;
  /** The requesting user (own grievance tickets, export ownership). */
  viewerUserId: number | null;
  /** Inclusive institute-local dates (`YYYY-MM-DD`). */
  from: string;
  to: string;
  /** `[start, end)` instants of the period (institute timezone applied). */
  start: Date;
  end: Date;
  timezone: string;
  /** Maximum detail rows to return (0 = totals and breakdowns only). */
  limit: number;
}

/**
 * Builds a parameterised `WHERE` clause. Values always go through replacements; column names are
 * literals from the caller. `in()` with an empty list matches nothing (never "everything").
 */
export class SqlFilter {
  readonly clauses: string[] = [];
  readonly params: Record<string, unknown>;
  private readonly counter: { n: number };

  constructor(base: Record<string, unknown> = {}, parent?: SqlFilter) {
    this.params = parent ? parent.params : { ...base };
    this.counter = parent ? parent.counter : { n: 0 };
    if (parent) Object.assign(this.params, base);
  }

  /** A filter for a nested sub-query whose values bind into this filter's parameters. */
  nested(): SqlFilter {
    return new SqlFilter({}, this);
  }

  private key(value: unknown) {
    const k = `p${this.counter.n++}`;
    this.params[k] = value;
    return k;
  }

  /** Adds a raw clause; `?` placeholders are bound to `values` in order. */
  where(clause: string, ...values: unknown[]): this {
    let i = 0;
    this.clauses.push(values.length ? clause.replace(/\?/g, () => `:${this.key(values[i++])}`) : clause);
    return this;
  }

  eq(column: string, value: number | string | null | undefined): this {
    if (value === null || value === undefined) return this;
    return this.where(`${column} = ?`, value);
  }

  in(column: string, values: readonly (number | string)[] | null | undefined): this {
    if (values === null || values === undefined) return this;
    if (!values.length) return this.where('1 = 0');
    return this.where(`${column} IN (?)`, [...values]);
  }

  /** `column` (DATE) within the inclusive local-date period. */
  dateBetween(column: string, from: string, to: string): this {
    return this.where(`${column} BETWEEN ? AND ?`, from, to);
  }

  /** `column` (DATETIME, UTC) within `[start, end)`. */
  instantBetween(column: string, start: Date, end: Date): this {
    return this.where(`${column} >= ? AND ${column} < ?`, utcSql(start), utcSql(end));
  }

  get sql(): string {
    return this.clauses.length ? this.clauses.join(' AND ') : '1 = 1';
  }
}

/**
 * A `Date` as a UTC `DATETIME` literal. Bind instants with this, never as `Date` objects: raw query
 * replacements format dates in the server's local timezone, while columns are stored in UTC.
 */
export const utcSql = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

/** Runs a read-only SELECT. Callers must have filtered on `institute_id`. */
export function reportQuery<T extends object>(sql: string, params: Record<string, unknown>): Promise<T[]> {
  return getSequelize().query<T>(sql, { replacements: params, type: QueryTypes.SELECT });
}

/** MySQL returns SUM/AVG of integers as strings; coerce to numbers. */
export const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

/** Rounds to `digits` decimals. */
export const round = (v: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** `part / whole` as a 0–100 percentage, or null when `whole` is 0. */
export const percent = (part: number, whole: number, digits = 1): number | null =>
  whole ? round((part / whole) * 100, digits) : null;

/** DATE/DATETIME column value → `YYYY-MM-DD` (DATE columns may arrive as strings or Dates). */
export function dateOnly(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** DATETIME column value (a `Date`, already UTC) → ISO instant. */
export function isoInstant(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `LIMIT` clause for detail queries (`limit` is an integer from the scope, never user input). */
export const limitSql = (limit: number) => `LIMIT ${Math.max(0, Math.floor(limit))}`;
