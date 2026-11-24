import { intlLocale } from '@/i18n';

/**
 * Display formatting for every screen, in the user's language (`en-IN` / `hi-IN`):
 * dates as `27 Nov 2026`, times as `9:00 pm`, money (integer paise) as `₹41,250`.
 * Use these instead of bare `toLocaleString()`, which shows US or ISO formats.
 *
 * Instants (ISO strings, `Date`, epoch ms) are shown in `opts.timeZone`, default the device's.
 * A `YYYY-MM-DD` string is a calendar date and is never shifted by a timezone.
 */

export type DateInput = Date | string | number;
export interface FormatOptions {
  /** IANA timezone, e.g. the institute's `Asia/Kolkata`. Default: the device timezone. */
  timeZone?: string;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMPTY = '—';

function toDate(value: DateInput): { date: Date; calendar: boolean } | null {
  if (typeof value === 'string') {
    const m = YMD.exec(value);
    // Noon UTC shown in UTC: the same calendar day everywhere.
    if (m) return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), calendar: true };
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : { date, calendar: false };
}

function dateFormat(
  value: DateInput | null | undefined,
  fmt: Intl.DateTimeFormatOptions,
  opts?: FormatOptions,
) {
  if (value === null || value === undefined || value === '') return EMPTY;
  const d = toDate(value);
  if (!d) return String(value);
  const timeZone = d.calendar ? 'UTC' : opts?.timeZone;
  return new Intl.DateTimeFormat(intlLocale(), { ...fmt, timeZone }).format(d.date);
}

/** `27 Nov 2026` */
export const formatDate = (value: DateInput | null | undefined, opts?: FormatOptions) =>
  dateFormat(value, { day: 'numeric', month: 'short', year: 'numeric' }, opts);

/** `Fri, 27 Nov`: for dates in the next or last few weeks. */
export const formatDayShort = (value: DateInput | null | undefined, opts?: FormatOptions) =>
  dateFormat(value, { weekday: 'short', day: 'numeric', month: 'short' }, opts);

/** `9:00 pm` */
export const formatTime = (value: DateInput | null | undefined, opts?: FormatOptions) =>
  dateFormat(value, { hour: 'numeric', minute: '2-digit' }, opts);

/** `27 Nov 2026, 9:00 pm` */
export const formatDateTime = (value: DateInput | null | undefined, opts?: FormatOptions) =>
  dateFormat(
    value,
    { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' },
    opts,
  );

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** `in 25 minutes`, `2 hours ago`, `yesterday`, `now` (Hindi: `25 मिनट में`). */
export function formatRelative(value: DateInput | null | undefined, now: DateInput = Date.now()): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  const d = toDate(value);
  const n = toDate(now);
  if (!d || !n) return String(value);
  const seconds = (d.date.getTime() - n.date.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}

const DURATION_UNITS: Record<string, [string, string, string]> = {
  en: ['h', 'min', 's'],
  hi: ['घं', 'मि', 'से'],
};

/** `1 h 5 min`, `42 min`, `45 s` from seconds (Hindi: `1 घं 5 मि`). */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return EMPTY;
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const [hu, mu, su] = DURATION_UNITS[intlLocale().slice(0, 2)] ?? DURATION_UNITS.en;
  if (h) return m ? `${h} ${hu} ${m} ${mu}` : `${h} ${hu}`;
  if (m) return `${m} ${mu}`;
  return `${s} ${su}`;
}

/** `₹41,250` from paise; paise are shown only when not whole rupees (`₹41,250.50`). */
export function formatMoney(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return EMPTY;
  const whole = paise % 100 === 0;
  return new Intl.NumberFormat(intlLocale(), {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(paise / 100);
}

/** `₹6.6L`, `₹1.2Cr` (Hindi `₹6.6 लाख`) from paise: for summary tiles; amounts below ₹1 lakh in full. */
export function formatMoneyCompact(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return EMPTY;
  if (Math.abs(paise) < 100_000_00) return formatMoney(Math.round(paise / 100) * 100);
  return new Intl.NumberFormat(intlLocale(), {
    style: 'currency',
    currency: 'INR',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(paise / 100);
}

/** `1,25,000` (Indian grouping). */
export const formatNumber = (n: number | null | undefined, maximumFractionDigits = 2) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? EMPTY
    : new Intl.NumberFormat(intlLocale(), { maximumFractionDigits }).format(n);

/** `92%` from an already-scaled value (92 = 92%). */
export const formatPercent = (n: number | null | undefined, maximumFractionDigits = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? EMPTY : `${formatNumber(n, maximumFractionDigits)}%`;
