import type { ReportCellValue, ReportColumnDto, ReportColumnType } from '@erp/shared';

/**
 * Value formatting shared by the report renderers. Money is stored in paise and shown in rupees;
 * percentages are already scaled (85.5 = 85.5%); datetimes are shown in the institute timezone.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const numberFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const moneyFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(instant: string | Date, timezone: string): ZonedParts | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  let fmt = partsFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(timezone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-01-12` → `12 Jan 2026` (no timezone shift; the value is a calendar date). */
export function displayDate(ymd: string): string {
  const m = YMD.exec(ymd);
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ymd;
}

/** Instant → `12 Jan 2026, 14:05` in the timezone. */
export function displayDateTime(instant: string | Date, timezone: string): string {
  const p = zonedParts(instant, timezone);
  if (!p) return String(instant);
  return `${pad(p.day)} ${MONTHS[p.month - 1]} ${p.year}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Instant → `2026-01-12 14:05` in the timezone (sortable, for CSV). */
export function plainDateTime(instant: string, timezone: string): string {
  const p = zonedParts(instant, timezone);
  if (!p) return instant;
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Human-readable value (PDF and summaries); `-` for empty values. */
export function displayValue(
  value: ReportCellValue,
  type: ReportColumnType,
  timezone: string,
  opts: { currency?: boolean } = {},
): string {
  if (value === null || value === '') return '-';
  if (typeof value === 'string' && type !== 'date' && type !== 'datetime') return value;
  switch (type) {
    case 'money':
      return `${opts.currency ? 'Rs. ' : ''}${moneyFmt.format(Number(value) / 100)}`;
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

/** Machine-friendly value (CSV): plain numbers, rupees for money, `YYYY-MM-DD HH:mm` local times. */
export function plainValue(value: ReportCellValue, type: ReportColumnType, timezone: string): string {
  if (value === null) return '';
  if (typeof value === 'string' && type !== 'date' && type !== 'datetime') return value;
  switch (type) {
    case 'money':
      return (Number(value) / 100).toFixed(2);
    case 'datetime':
      return plainDateTime(String(value), timezone);
    default:
      return String(value);
  }
}

const UNITS: Partial<Record<ReportColumnType, [suffix: string, skipIf: RegExp]>> = {
  money: [' (Rs.)', /\(rs\.?\)|₹/i],
  percent: [' (%)', /%/],
  hours: [' (hours)', /hour|\(h\)/i],
};

/** Column header with its unit, for exports where values are plain numbers. */
export function headerWithUnit(col: ReportColumnDto): string {
  const unit = UNITS[col.type];
  return unit && !unit[1].test(col.label) ? `${col.label}${unit[0]}` : col.label;
}

/** Right-aligned column types. */
export const isNumericType = (type: ReportColumnType) =>
  type === 'number' || type === 'money' || type === 'percent' || type === 'hours';
