import { z } from 'zod';
import {
  REPORT_DATE_PRESETS,
  REPORT_DATE_PRESET_LABELS,
  REPORT_EXPORT_FORMATS,
  REPORT_MAX_RANGE_DAYS,
  type ReportDatePreset,
  type ReportFiltersInput,
  type ReportPeriodDto,
} from '@erp/shared';
import { BadRequest } from '../../shared/errors';
import { todayIn, zonedDateTimeToUtc } from '../../shared/timezone';

export const DEFAULT_REPORT_PRESET: ReportDatePreset = 'this_month';

const ymdString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optionalId = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.number().int().positive().optional(),
);
const optionalYmd = z.preprocess((v) => (v === '' || v === null ? undefined : v), ymdString.optional());

/** Query-string / body filters shared by report, dashboard and export endpoints. */
export const reportFiltersSchema = z.object({
  preset: z.enum(REPORT_DATE_PRESETS).optional(),
  from: optionalYmd,
  to: optionalYmd,
  branchId: optionalId,
  courseId: optionalId,
  batchId: optionalId,
});

export const createExportSchema = reportFiltersSchema.extend({ format: z.enum(REPORT_EXPORT_FORMATS) });

/** Keeps only the filter fields (drops `format` and unknown keys) for storage. */
export function cleanFilters(input: ReportFiltersInput): ReportFiltersInput {
  const out: ReportFiltersInput = {};
  if (input.preset) out.preset = input.preset;
  if (input.from) out.from = input.from;
  if (input.to) out.to = input.to;
  if (input.branchId) out.branchId = input.branchId;
  if (input.courseId) out.courseId = input.courseId;
  if (input.batchId) out.batchId = input.batchId;
  return out;
}

// ---------------------------------------------------------------- calendar maths on YYYY-MM-DD

const pad = (n: number) => String(n).padStart(2, '0');

/** Normalised `YYYY-MM-DD` for (possibly overflowing) year/month/day, e.g. day 0 = last day of previous month. */
export function ymd(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

/** True when `date` is a real calendar date in `YYYY-MM-DD` form. */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const { y, m, d } = parts(date);
  return y >= 1900 && y <= 9999 && ymd(y, m, d) === date;
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parts(date);
  return ymd(y, m, d + days);
}

/** Inclusive number of days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000) + 1;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-17` → `17 Nov 2026`. */
export function formatYmd(date: string): string {
  const { y, m, d } = parts(date);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Inclusive local-date range of a preset, relative to `today` (institute-local). */
export function presetRange(
  preset: Exclude<ReportDatePreset, 'custom'>,
  today: string,
): { from: string; to: string } {
  const { y, m } = parts(today);
  const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const quarter = Math.floor((m - 1) / 3);
  const fyStart = m >= 4 ? y : y - 1;
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today };
    case 'this_week':
      return { from: monday, to: today };
    case 'last_week':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'this_month':
      return { from: ymd(y, m, 1), to: today };
    case 'last_month':
      return { from: ymd(y, m - 1, 1), to: ymd(y, m, 0) };
    case 'this_quarter':
      return { from: ymd(y, quarter * 3 + 1, 1), to: today };
    case 'last_quarter':
      return { from: ymd(y, quarter * 3 - 2, 1), to: ymd(y, quarter * 3 + 1, 0) };
    case 'this_year':
      return { from: ymd(y, 1, 1), to: today };
    case 'this_fy':
      return { from: ymd(fyStart, 4, 1), to: today };
    case 'last_fy':
      return { from: ymd(fyStart - 1, 4, 1), to: ymd(fyStart, 3, 31) };
  }
}

export interface ResolvedPeriod extends ReportPeriodDto {
  /** `[start, end)` UTC instants of the local-date range. */
  start: Date;
  end: Date;
}

/**
 * Resolves a preset or custom range in the institute timezone. "This …" presets run up to today.
 * A range without a preset is treated as custom; custom ranges need valid `from` ≤ `to` within
 * `REPORT_MAX_RANGE_DAYS`.
 */
export function resolvePeriod(input: ReportFiltersInput, timezone: string, now = new Date()): ResolvedPeriod {
  const preset: ReportDatePreset =
    input.preset ?? (input.from || input.to ? 'custom' : DEFAULT_REPORT_PRESET);
  let range: { from: string; to: string };
  if (preset === 'custom') {
    if (!input.from || !input.to) throw BadRequest('A custom range needs both from and to dates');
    if (!isRealDate(input.from) || !isRealDate(input.to))
      throw BadRequest('Dates must be valid YYYY-MM-DD dates');
    if (input.from > input.to) throw BadRequest('The from date must be on or before the to date');
    if (daysBetween(input.from, input.to) > REPORT_MAX_RANGE_DAYS) {
      throw BadRequest(`The date range can be at most ${REPORT_MAX_RANGE_DAYS} days`);
    }
    range = { from: input.from, to: input.to };
  } else {
    range = presetRange(preset, todayIn(timezone, now));
  }
  const dates =
    range.from === range.to ? formatYmd(range.from) : `${formatYmd(range.from)} – ${formatYmd(range.to)}`;
  return {
    preset,
    from: range.from,
    to: range.to,
    timezone,
    label: `${REPORT_DATE_PRESET_LABELS[preset]} (${dates})`,
    start: zonedDateTimeToUtc(range.from, '00:00', timezone),
    end: zonedDateTimeToUtc(addDays(range.to, 1), '00:00', timezone),
  };
}

/** Period DTO without the internal instants. */
export const periodDto = ({ preset, from, to, timezone, label }: ReportPeriodDto): ReportPeriodDto => ({
  preset,
  from,
  to,
  timezone,
  label,
});
