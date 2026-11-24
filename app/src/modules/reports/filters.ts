import {
  REPORT_DATE_PRESETS,
  REPORT_MAX_RANGE_DAYS,
  type ReportAudience,
  type ReportDatePreset,
  type ReportFilterKind,
  type ReportFilterOptionsDto,
  type ReportFiltersInput,
} from '@erp/shared';
import type { LocationQuery, LocationQueryRaw } from 'vue-router';
import { i18n } from '@/i18n';

/** Filter form state of a report or dashboard; mirrored in the route query so views can be shared. */
export interface ReportFilterState {
  preset: ReportDatePreset;
  /** `YYYY-MM-DD`, used with the `custom` preset. */
  from: string;
  to: string;
  branchId: number | null;
  courseId: number | null;
  batchId: number | null;
}

export const DEFAULT_PRESET: ReportDatePreset = 'this_month';
const ALL_FILTERS: readonly ReportFilterKind[] = ['date', 'branch', 'course', 'batch'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const emptyFilterState = (preset: ReportDatePreset = DEFAULT_PRESET): ReportFilterState => ({
  preset,
  from: '',
  to: '',
  branchId: null,
  courseId: null,
  batchId: null,
});

/** Students and parents only see their own (or their children's) data: no branch/course/batch filters. */
export const isPersonalAudience = (audience: ReportAudience | undefined) =>
  audience === 'student' || audience === 'parent';

const first = (v: LocationQuery[string]) => (Array.isArray(v) ? v[0] : v);
const idParam = (v: LocationQuery[string]): number | null => {
  const n = Number(first(v));
  return Number.isInteger(n) && n > 0 ? n : null;
};
const dateParam = (v: LocationQuery[string]): string => {
  const s = first(v);
  return typeof s === 'string' && YMD.test(s) ? s : '';
};

/** Filter state from a route query; unknown or malformed values are ignored. */
export function stateFromQuery(query: LocationQuery, fallbackPreset = DEFAULT_PRESET): ReportFilterState {
  const preset = first(query.preset);
  const from = dateParam(query.from);
  const to = dateParam(query.to);
  const known = (REPORT_DATE_PRESETS as readonly unknown[]).includes(preset);
  return {
    preset: known ? (preset as ReportDatePreset) : from || to ? 'custom' : fallbackPreset,
    from,
    to,
    branchId: idParam(query.branchId),
    courseId: idParam(query.courseId),
    batchId: idParam(query.batchId),
  };
}

/** Route query for a filter state (empty values omitted). */
export function stateToQuery(state: ReportFilterState): LocationQueryRaw {
  const query: LocationQueryRaw = { preset: state.preset };
  if (state.preset === 'custom') {
    if (state.from) query.from = state.from;
    if (state.to) query.to = state.to;
  }
  if (state.branchId) query.branchId = String(state.branchId);
  if (state.courseId) query.courseId = String(state.courseId);
  if (state.batchId) query.batchId = String(state.batchId);
  return query;
}

/** API filters for a state, limited to the filters the report supports and the caller may use. */
export function toFiltersInput(
  state: ReportFilterState,
  allowed: readonly ReportFilterKind[] = ALL_FILTERS,
  audience?: ReportAudience,
): ReportFiltersInput {
  const out: ReportFiltersInput = {};
  if (allowed.includes('date')) {
    out.preset = state.preset;
    if (state.preset === 'custom') {
      out.from = state.from;
      out.to = state.to;
    }
  }
  if (isPersonalAudience(audience)) return out;
  if (allowed.includes('branch') && state.branchId) out.branchId = state.branchId;
  if (allowed.includes('course') && state.courseId) out.courseId = state.courseId;
  if (allowed.includes('batch') && state.batchId) out.batchId = state.batchId;
  return out;
}

/** Inclusive number of days between two `YYYY-MM-DD` dates. */
export function daysInRange(from: string, to: string): number {
  const ms = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000) + 1;
}

/** Today's `YYYY-MM-DD` in a timezone. */
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .slice(0, 10);
}

/** Why a custom range can't be used yet, or null (same rules as the API). */
export function customRangeError(state: Pick<ReportFilterState, 'preset' | 'from' | 'to'>): string | null {
  if (state.preset !== 'custom') return null;
  const { t } = i18n.global;
  if (!state.from || !state.to) return t('reports.filters.errors.bothDates');
  if (!YMD.test(state.from) || !YMD.test(state.to)) return t('reports.filters.errors.format');
  if (state.from > state.to) return t('reports.filters.errors.order');
  if (daysInRange(state.from, state.to) > REPORT_MAX_RANGE_DAYS) {
    return t('reports.filters.errors.maxRange', { days: REPORT_MAX_RANGE_DAYS });
  }
  return null;
}

/** Batches that match the chosen branch and course. */
export function batchChoices(
  options: Pick<ReportFilterOptionsDto, 'batches'>,
  state: Pick<ReportFilterState, 'branchId' | 'courseId'>,
) {
  return options.batches.filter(
    (b) =>
      (!state.branchId || b.branchId === state.branchId) &&
      (!state.courseId || b.courseId === state.courseId),
  );
}

/**
 * Drops choices the caller can no longer pick (e.g. a branch outside their scope from a shared link,
 * or a batch that no longer matches the branch/course) so the API isn't asked for them.
 */
export function reconcileState(state: ReportFilterState, options: ReportFilterOptionsDto): ReportFilterState {
  if (isPersonalAudience(options.audience))
    return { ...state, branchId: null, courseId: null, batchId: null };
  const next = { ...state };
  if (next.branchId && !options.branches.some((b) => b.id === next.branchId)) next.branchId = null;
  if (next.courseId && !options.courses.some((c) => c.id === next.courseId)) next.courseId = null;
  if (next.batchId && !batchChoices(options, next).some((b) => b.id === next.batchId)) next.batchId = null;
  return next;
}

/** Translated name of a date preset (`this_month` → `This month`). */
export const presetLabel = (preset: ReportDatePreset) => i18n.global.t(`reports.presets.${preset}`);
