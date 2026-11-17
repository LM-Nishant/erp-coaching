/** Calendar helpers on `YYYY-MM-DD` strings (UTC arithmetic, so no timezone drift). */

const DAY_MS = 86400000;

export const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(d: string, n: number): string {
  return fromUtc(toUtc(d) + n * DAY_MS);
}

/** Inclusive day count; 0 when `to` is before `from`. */
export function daysInclusive(from: string, to: string): number {
  return Math.max(0, Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ms = toUtc(from); ms <= toUtc(to); ms += DAY_MS) out.push(fromUtc(ms));
  return out;
}

export function monthBounds(year: number, month: number) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(days).padStart(2, '0')}`, days };
}

export const maxDate = (a: string, b: string) => (a > b ? a : b);
export const minDate = (a: string, b: string) => (a < b ? a : b);

/** Today's date in server-local time. */
export function today(now = new Date()): string {
  const off = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - off).toISOString().slice(0, 10);
}

export const isoDate = /^\d{4}-\d{2}-\d{2}$/;
export const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
