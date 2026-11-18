import type { ReportCellValue, ReportColumnType, ReportMetricDto } from '@erp/shared';

/**
 * Display formatting for report values (mirrors the backend renderers): money is paise shown in
 * rupees, percentages are already scaled (85.5 = 85.5%), datetimes are shown in the institute timezone.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const numberFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const moneyFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-01-12` → `12 Jan 2026` (a calendar date: no timezone shift). */
export function displayDate(ymd: string): string {
  const m = YMD.exec(ymd);
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ymd;
}

/** Instant → `12 Jan 2026, 14:05` in the timezone. */
export function displayDateTime(instant: string, timezone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${pad(Number(parts.hour))}:${parts.minute}`;
}

export const money = (paise: number) => `₹${moneyFmt.format(paise / 100)}`;

/** Human-readable cell or metric value; `—` when empty. */
export function formatValue(
  value: ReportCellValue | undefined,
  type: ReportColumnType,
  timezone: string,
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' && type !== 'date' && type !== 'datetime') return value;
  switch (type) {
    case 'money':
      return money(Number(value));
    case 'percent':
      return `${percentFmt.format(Number(value))}%`;
    case 'hours':
      return `${numberFmt.format(Number(value))} h`;
    case 'number':
      return numberFmt.format(Number(value));
    case 'date':
      return displayDate(String(value));
    case 'datetime':
      return displayDateTime(String(value), timezone);
    default:
      return String(value);
  }
}

export const formatMetric = (m: ReportMetricDto, timezone: string) => formatValue(m.value, m.type, timezone);

/** A tile whose value is already formatted (e.g. a storage size). */
export interface DisplayMetric {
  key: string;
  label: string;
  display: string;
  hint?: string;
  tone?: ReportMetricDto['tone'];
}
export type Metric = ReportMetricDto | DisplayMetric;

export const metricText = (m: Metric, timezone: string) =>
  'display' in m ? m.display : formatMetric(m, timezone);

/** Right-aligned column types. */
export const isNumericType = (type: ReportColumnType) =>
  type === 'number' || type === 'money' || type === 'percent' || type === 'hours';

/** `1536` → `1.5 KB`. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? Math.round(n) : Math.round(n * 10) / 10} ${units[i]}`;
}

/** `this_month` → `This month`; for raw status/feature keys. */
export const humanize = (key: string) => {
  const s = key.replace(/[_.-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
