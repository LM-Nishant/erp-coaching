import type { BillingCycle } from '@erp/shared';
import { DEFAULT_INSTITUTE_TIMEZONE, todayIn } from '../../shared/timezone';

/** SaaS documents (issue/due dates, financial year) follow the operator's timezone. */
export const BILLING_TIMEZONE = DEFAULT_INSTITUTE_TIMEZONE;
export const DAY_MS = 86_400_000;

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

/** Calendar months in UTC, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const daysInMonth = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, daysInMonth));
  return r;
}

export const addCycle = (d: Date, cycle: BillingCycle) => addMonths(d, cycle === 'yearly' ? 12 : 1);

/** Operator-local calendar date (`YYYY-MM-DD`). */
export const billingDate = (now = new Date()) => todayIn(BILLING_TIMEZONE, now);

const DAY_FORMAT = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: BILLING_TIMEZONE,
});

/** Human date for messages, e.g. `18 Nov 2026` (operator timezone). */
export const formatDay = (d: Date) => DAY_FORMAT.format(d);

/** Indian financial year of a `YYYY-MM-DD` date, e.g. 2026-11-18 → `26-27`. */
export function financialYear(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Usage is metered per UTC calendar month (same window as the AI quota). */
export const startOfMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** `YYYY-MM-01` of the UTC month. */
export const monthKey = (d = new Date()) => isoDay(startOfMonth(d));

/** `YYYY-MM-DD` + n calendar days. */
export function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return isoDay(new Date(Date.UTC(y, m - 1, d + days)));
}

/** GST state codes (first two digits of a GSTIN) by normalised state / UT name. */
const GST_STATE_CODES: Record<string, string> = {
  jammuandkashmir: '01',
  jammukashmir: '01',
  himachalpradesh: '02',
  punjab: '03',
  chandigarh: '04',
  uttarakhand: '05',
  uttaranchal: '05',
  haryana: '06',
  delhi: '07',
  newdelhi: '07',
  nctofdelhi: '07',
  rajasthan: '08',
  uttarpradesh: '09',
  bihar: '10',
  sikkim: '11',
  arunachalpradesh: '12',
  nagaland: '13',
  manipur: '14',
  mizoram: '15',
  tripura: '16',
  meghalaya: '17',
  assam: '18',
  westbengal: '19',
  jharkhand: '20',
  odisha: '21',
  orissa: '21',
  chhattisgarh: '22',
  madhyapradesh: '23',
  gujarat: '24',
  dadraandnagarhavelianddamananddiu: '26',
  dadraandnagarhaveli: '26',
  damananddiu: '26',
  maharashtra: '27',
  karnataka: '29',
  goa: '30',
  lakshadweep: '31',
  kerala: '32',
  tamilnadu: '33',
  puducherry: '34',
  pondicherry: '34',
  andamanandnicobarislands: '35',
  andamanandnicobar: '35',
  telangana: '36',
  andhrapradesh: '37',
  ladakh: '38',
};

/** GST state code of a party: GSTIN prefix, else the state name. */
export function gstStateCode(party: { gstin: string | null; state: string | null }): string | null {
  const gstin = party.gstin?.trim();
  if (gstin && /^\d{2}/.test(gstin)) return gstin.slice(0, 2);
  const name = (party.state ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
  return name ? (GST_STATE_CODES[name] ?? name) : null;
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
