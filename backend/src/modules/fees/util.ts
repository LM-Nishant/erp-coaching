import { audit } from '../../shared/audit/audit.service';
import { instituteToday } from '../../shared/timezone';
export const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** Today (YYYY-MM-DD) in the current tenant institute's timezone. */
export function today(): Promise<string> {
  return instituteToday();
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Indian financial year label of a YYYY-MM-DD date, e.g. `2026-27` for 1 Apr 2026 – 31 Mar 2027. */
export function financialYear(date: string): string {
  const [year, month] = date.split('-').map(Number);
  const y = month >= 4 ? year : year - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** 123456 paise → "1,234.56" (Indian grouping). */
export function formatRupees(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${rest ? `${rest},` : ''}${last3}.${p}`;
}

/** Splits `total` into `n` parts, the last part absorbing rounding. */
export function splitEvenly(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_v, i) => (i === n - 1 ? total - base * (n - 1) : base));
}

/** Retries a transactional unit of work on InnoDB deadlocks / lock wait timeouts. */
export async function withLockRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { parent?: { code?: string } }).parent?.code;
      if (i >= attempts || (code !== 'ER_LOCK_DEADLOCK' && code !== 'ER_LOCK_WAIT_TIMEOUT')) throw err;
      await new Promise((r) => setTimeout(r, 20 * i));
    }
  }
}

/** Audit with before/after snapshots folded into metadata (AuditInput has no diff fields). */
export function auditFee(input: {
  action: string;
  entityType?: string;
  entityId?: string | number;
  branchId?: number | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { before, after, metadata, ...rest } = input;
  const meta: Record<string, unknown> = { ...(metadata ?? {}) };
  if (before !== undefined) meta.before = before;
  if (after !== undefined) meta.after = after;
  return audit({ ...rest, ...(Object.keys(meta).length ? { metadata: meta } : {}) });
}
