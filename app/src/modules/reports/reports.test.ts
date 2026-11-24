import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { ReportFilterOptionsDto, ReportTableDto, SaasDashboardDto } from '@erp/shared';
import type { LocationQuery } from 'vue-router';
import { i18n } from '@/i18n';
import ReportTable from './components/ReportTable.vue';
import {
  customRangeError,
  emptyFilterState,
  reconcileState,
  stateFromQuery,
  stateToQuery,
  toFiltersInput,
  todayIn,
} from './filters';
import { displayDateTime, formatBytes, formatValue } from './format';
import { institutesTable, plansTable, platformRevenue, saasExportFileName } from './platform';

const TZ = 'Asia/Kolkata';

const options: ReportFilterOptionsDto = {
  timezone: TZ,
  today: '2026-11-18',
  presets: [],
  defaultPreset: 'this_month',
  branches: [
    { id: 1, name: 'Main' },
    { id: 2, name: 'North' },
  ],
  courses: [{ id: 10, name: 'JEE' }],
  batches: [
    { id: 100, name: 'JEE A', branchId: 1, courseId: 10 },
    { id: 200, name: 'JEE N', branchId: 2, courseId: 10 },
  ],
  audience: 'management',
};

describe('report filters', () => {
  it('reads the route query and ignores malformed values', () => {
    expect(
      stateFromQuery({ preset: 'last_month', branchId: '2', courseId: 'abc', batchId: '-1', from: 'x' }),
    ).toEqual({ ...emptyFilterState('last_month'), branchId: 2 });
    expect(stateFromQuery({ preset: 'bogus' }).preset).toBe('this_month');
    // Dates without a preset (e.g. a hand-edited link) mean a custom range.
    expect(stateFromQuery({ from: '2026-01-01', to: '2026-01-31' })).toMatchObject({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });

  it('round-trips through the route query', () => {
    const state = {
      preset: 'custom' as const,
      from: '2026-01-01',
      to: '2026-03-31',
      branchId: 1,
      courseId: 10,
      batchId: 100,
    };
    expect(stateFromQuery(stateToQuery(state) as LocationQuery)).toEqual(state);
    // Dates only belong to custom ranges.
    expect(stateToQuery({ ...state, preset: 'this_week' })).toEqual({
      preset: 'this_week',
      branchId: '1',
      courseId: '10',
      batchId: '100',
    });
  });

  it('only sends the filters a report supports and the audience may use', () => {
    const state = {
      preset: 'custom' as const,
      from: '2026-01-01',
      to: '2026-01-31',
      branchId: 1,
      courseId: 10,
      batchId: 100,
    };
    expect(toFiltersInput(state, ['date', 'branch'])).toEqual({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      branchId: 1,
    });
    expect(toFiltersInput({ ...state, preset: 'today' }, undefined, 'parent')).toEqual({ preset: 'today' });
    expect(toFiltersInput({ ...state, preset: 'today' }, undefined, 'teacher')).toEqual({
      preset: 'today',
      branchId: 1,
      courseId: 10,
      batchId: 100,
    });
  });

  it('validates custom ranges like the API', () => {
    const custom = (from: string, to: string) => customRangeError({ preset: 'custom', from, to });
    expect(customRangeError({ preset: 'this_month', from: '', to: '' })).toBeNull();
    expect(custom('2026-01-01', '')).toMatch(/both/);
    expect(custom('2026-02-01', '2026-01-31')).toMatch(/on or before/);
    expect(custom('2024-01-01', '2025-12-31')).toBeNull(); // 731 days
    expect(custom('2024-01-01', '2026-01-01')).toMatch(/at most 731 days/);
  });

  it('drops choices outside the caller scope or the chosen branch', () => {
    const state = { ...emptyFilterState(), branchId: 1, courseId: 10, batchId: 200 };
    expect(reconcileState(state, options)).toMatchObject({ branchId: 1, courseId: 10, batchId: null });
    expect(reconcileState({ ...state, branchId: 9 }, options)).toMatchObject({
      branchId: null,
      batchId: 200,
    });
    expect(reconcileState(state, { ...options, audience: 'student' })).toMatchObject({
      branchId: null,
      courseId: null,
      batchId: null,
    });
  });

  it('evaluates today in the institute timezone', () => {
    const lateUtc = new Date('2026-11-18T20:00:00Z');
    expect(todayIn(TZ, lateUtc)).toBe('2026-11-19');
    expect(todayIn('UTC', lateUtc)).toBe('2026-11-18');
  });
});

describe('report formatting', () => {
  it('formats values by column type', () => {
    expect(formatValue(12345678, 'money', TZ)).toBe('₹1,23,456.78');
    expect(formatValue(85.55, 'percent', TZ)).toBe('85.6%');
    expect(formatValue(2.5, 'hours', TZ)).toBe('2.5 h');
    expect(formatValue('2026-01-05', 'date', TZ)).toBe('5 Jan 2026');
    expect(formatValue('2026-01-12T08:35:00.000Z', 'datetime', TZ)).toBe('12 Jan 2026, 2:05 pm');
    expect(formatValue(null, 'money', TZ)).toBe('—');
    expect(formatValue('Paid', 'text', TZ)).toBe('Paid');
  });

  it('shows datetimes in the given timezone and sizes in binary units', () => {
    expect(displayDateTime('2026-03-31T19:00:00Z', TZ)).toBe('1 Apr 2026, 12:30 am');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 ** 3)).toBe('25 GB');
  });
});

describe('ReportTable', () => {
  const table: ReportTableDto = {
    key: 'payments',
    title: 'Payments',
    columns: [
      { key: 'student', label: 'Student', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
    rows: [
      { student: 'Asha', amount: 150000 },
      { student: 'Ravi', amount: null },
    ],
    totalRows: 5,
  };

  it('formats cells, right-aligns numbers and flags truncated tables', () => {
    const w = mount(ReportTable, { props: { table, timezone: TZ }, global: { plugins: [i18n] } });
    const cells = w.findAll('tbody td').map((td) => td.text());
    expect(cells).toEqual(['Asha', '₹1,500', 'Ravi', '—']);
    expect(w.findAll('th')[1].classes()).toContain('num');
    expect(w.text()).toContain('Showing 2 of 5 rows');
  });

  it('shows an empty state', () => {
    const w = mount(ReportTable, {
      props: { table: { ...table, rows: [], totalRows: 0 }, timezone: TZ },
      global: { plugins: [i18n] },
    });
    expect(w.find('table').exists()).toBe(false);
    expect(w.text()).toContain('No data for these filters.');
  });
});

describe('platform analytics', () => {
  const dashboard = {
    period: { preset: 'this_month', from: '2026-11-01', to: '2026-11-30', timezone: TZ, label: '' },
    institutes: { total: 3, newInPeriod: 1, byStatus: [] },
    subscriptions: {
      byStatus: [],
      byPlan: [
        { planId: 1, planName: 'Basic', count: 2 },
        { planId: 2, planName: 'Pro', count: 1 },
      ],
      endingSoon: 0,
    },
    revenue: {
      source: 'subscriptions',
      currency: 'INR',
      mrrPaise: 600000,
      arrPaise: 7200000,
      revenueInPeriodPaise: null,
      outstandingPaise: 0,
      paidSubscriptions: 2,
      byPlan: [
        { planId: 2, planName: 'Pro', subscriptions: 1, mrrPaise: 500000 },
        { planId: 3, planName: 'Legacy', subscriptions: 1, mrrPaise: 100000 },
      ],
    },
    institutesTable: [],
  } as unknown as SaasDashboardDto;

  it('merges subscriptions and revenue per plan, highest MRR first', () => {
    expect(plansTable(dashboard).rows).toEqual([
      { plan: 'Pro', subscriptions: 1, paying: 1, mrr: 500000 },
      { plan: 'Legacy', subscriptions: 0, paying: 1, mrr: 100000 },
      { plan: 'Basic', subscriptions: 2, paying: 0, mrr: 0 },
    ]);
  });

  it('marks untracked revenue instead of showing zero', () => {
    const tiles = Object.fromEntries(platformRevenue(dashboard).map((m) => [m.key, m]));
    expect(tiles.revenue).toEqual({ key: 'revenue', label: 'Revenue in period', display: 'Not tracked' });
    expect(tiles.outstanding).toMatchObject({ value: 0, type: 'money' });
  });

  it('names exports like the API and reports table truncation', () => {
    expect(saasExportFileName(dashboard, 'xlsx')).toBe('saas-institutes-2026-11-01-to-2026-11-30.xlsx');
    expect(institutesTable(dashboard).totalRows).toBe(3);
  });
});
