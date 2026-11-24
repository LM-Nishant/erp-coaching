import type { ReportCellValue, ReportColumnType, ReportMetricDto } from '@erp/shared';
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent } from '@/core/format';
import { i18n } from '@/i18n';

/**
 * Display formatting for report values, in the user's language (see core/format): money is paise shown in
 * rupees, percentages are already scaled (85.5 = 85.5%), datetimes are shown in the institute timezone.
 */

/** `2026-01-12` → `12 Jan 2026` (a calendar date: no timezone shift). */
export const displayDate = (ymd: string) => formatDate(ymd);

/** Instant → `12 Jan 2026, 2:05 pm` in the timezone. */
export const displayDateTime = (instant: string, timezone: string) =>
  formatDateTime(instant, { timeZone: timezone });

export const money = (paise: number) => formatMoney(paise);

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
      return formatPercent(Number(value), 1);
    case 'hours':
      return i18n.global.t('reports.units.hours', { n: formatNumber(Number(value)) });
    case 'number':
      return formatNumber(Number(value));
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

/** `this_month` → `This month`; for raw feature keys with no translation. */
export const humanize = (key: string) => {
  const s = key.replace(/[_.-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Translated label for a raw key under `prefix` (e.g. `reports.platform.status`), else the humanized key. */
export function keyLabel(prefix: string, key: string): string {
  const path = `${prefix}.${key}`;
  return i18n.global.te(path) || i18n.global.te(path, 'en') ? i18n.global.t(path) : humanize(key);
}
