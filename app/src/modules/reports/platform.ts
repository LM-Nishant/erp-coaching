import {
  DEFAULT_INSTITUTE_TIMEZONE,
  REPORT_DATE_PRESETS,
  REPORT_DATE_PRESET_LABELS,
  type ReportExportFormat,
  type ReportFilterOptionsDto,
  type ReportTableDto,
  type SaasDashboardDto,
} from '@erp/shared';
import { DEFAULT_PRESET, todayIn } from './filters';
import { formatBytes, humanize, type Metric } from './format';

/** SaaS figures are evaluated in the platform default timezone. */
export const PLATFORM_TIMEZONE = DEFAULT_INSTITUTE_TIMEZONE;

/** Period-only filter options for the platform pages (no tenant branches/courses/batches). */
export const platformFilterOptions = (now = new Date()): ReportFilterOptionsDto => ({
  timezone: PLATFORM_TIMEZONE,
  today: todayIn(PLATFORM_TIMEZONE, now),
  presets: REPORT_DATE_PRESETS.map((value) => ({ value, label: REPORT_DATE_PRESET_LABELS[value] })),
  defaultPreset: DEFAULT_PRESET,
  branches: [],
  courses: [],
  batches: [],
  audience: 'management',
});

/** Same name the API sends (its `Content-Disposition` header isn't readable cross-origin). */
export const saasExportFileName = (d: Pick<SaasDashboardDto, 'period'>, format: ReportExportFormat) =>
  `saas-institutes-${d.period.from}-to-${d.period.to}.${format}`;

const count = (n: number) => n.toLocaleString('en-IN');

export function platformHeadline(d: SaasDashboardDto): Metric[] {
  return [
    {
      key: 'institutes',
      label: 'Institutes',
      value: d.institutes.total,
      type: 'number',
      hint: `${count(d.institutes.newInPeriod)} new in period`,
    },
    {
      key: 'users',
      label: 'Institute users',
      value: d.users.total,
      type: 'number',
      hint: `${count(d.users.active)} active · ${count(d.users.newInPeriod)} new`,
    },
    {
      key: 'students',
      label: 'Students',
      value: d.students.total,
      type: 'number',
      hint: `${count(d.students.active)} active · ${count(d.students.admittedInPeriod)} admitted`,
    },
    { key: 'teachers', label: 'Teachers', value: d.teachers.total, type: 'number' },
    { key: 'branches', label: 'Branches', value: d.branches.total, type: 'number' },
  ];
}

export function platformSubscriptions(d: SaasDashboardDto): Metric[] {
  return [
    ...d.subscriptions.byStatus.map((s): Metric => ({
      key: `status-${s.status}`,
      label: humanize(s.status),
      value: s.count,
      type: 'number',
    })),
    {
      key: 'ending-soon',
      label: 'Ending in 30 days',
      value: d.subscriptions.endingSoon,
      type: 'number',
      tone: d.subscriptions.endingSoon ? 'warning' : undefined,
    },
  ];
}

export function platformRevenue(d: SaasDashboardDto): Metric[] {
  const r = d.revenue;
  const tracked = (key: string, label: string, paise: number | null): Metric =>
    paise === null ? { key, label, display: 'Not tracked' } : { key, label, value: paise, type: 'money' };
  return [
    { key: 'mrr', label: 'MRR', value: r.mrrPaise, type: 'money' },
    { key: 'arr', label: 'ARR', value: r.arrPaise, type: 'money' },
    tracked('revenue', 'Revenue in period', r.revenueInPeriodPaise),
    tracked('outstanding', 'Outstanding', r.outstandingPaise),
    { key: 'paid', label: 'Paid subscriptions', value: r.paidSubscriptions, type: 'number' },
  ];
}

export const revenueNote = (d: SaasDashboardDto) =>
  d.revenue.source === 'subscriptions'
    ? 'Revenue is estimated from the plan prices of paid, active subscriptions. Collected and outstanding amounts appear once SaaS billing is connected.'
    : 'Revenue comes from SaaS invoices and payments.';

export function platformUsage(d: SaasDashboardDto): Metric[] {
  return [
    {
      key: 'storage',
      label: 'Storage used',
      display: formatBytes(d.usage.storageBytes),
      hint: `${count(d.usage.files)} files`,
    },
    { key: 'ai-requests', label: 'AI requests in period', value: d.usage.aiRequestsInPeriod, type: 'number' },
    { key: 'ai-tokens', label: 'AI tokens in period', value: d.usage.aiTokensInPeriod, type: 'number' },
  ];
}

/** Subscriptions and recurring revenue per plan (merged by plan). */
export function plansTable(d: SaasDashboardDto): ReportTableDto {
  const rows = new Map<number, { plan: string; subscriptions: number; paying: number; mrr: number }>();
  for (const p of d.subscriptions.byPlan) {
    rows.set(p.planId, { plan: p.planName, subscriptions: p.count, paying: 0, mrr: 0 });
  }
  for (const p of d.revenue.byPlan) {
    const row = rows.get(p.planId) ?? { plan: p.planName, subscriptions: 0, paying: 0, mrr: 0 };
    rows.set(p.planId, { ...row, paying: p.subscriptions, mrr: p.mrrPaise });
  }
  const list = [...rows.values()].sort((a, b) => b.mrr - a.mrr || b.subscriptions - a.subscriptions);
  return {
    key: 'plans',
    title: 'Plans',
    columns: [
      { key: 'plan', label: 'Plan', type: 'text' },
      { key: 'subscriptions', label: 'Subscriptions', type: 'number' },
      { key: 'paying', label: 'Paying', type: 'number' },
      { key: 'mrr', label: 'MRR', type: 'money' },
    ],
    rows: list,
    totalRows: list.length,
  };
}

export function aiFeatureTable(d: SaasDashboardDto): ReportTableDto {
  return {
    key: 'ai-features',
    title: 'AI usage by feature',
    columns: [
      { key: 'feature', label: 'Feature', type: 'text' },
      { key: 'requests', label: 'Requests', type: 'number' },
      { key: 'tokens', label: 'Tokens', type: 'number' },
    ],
    rows: d.usage.aiByFeature.map((f) => ({
      feature: humanize(f.feature),
      requests: f.requests,
      tokens: f.tokens,
    })),
    totalRows: d.usage.aiByFeature.length,
  };
}

export function institutesTable(d: SaasDashboardDto): ReportTableDto {
  return {
    key: 'institutes',
    title: 'Institutes',
    columns: [
      { key: 'name', label: 'Institute', type: 'text' },
      { key: 'status', label: 'Status', type: 'text' },
      { key: 'plan', label: 'Plan', type: 'text' },
      { key: 'subscription', label: 'Subscription', type: 'text' },
      { key: 'endsAt', label: 'Subscription ends', type: 'datetime' },
      { key: 'branches', label: 'Branches', type: 'number' },
      { key: 'users', label: 'Users', type: 'number' },
      { key: 'students', label: 'Students', type: 'number' },
      { key: 'teachers', label: 'Teachers', type: 'number' },
      { key: 'storage', label: 'Storage', type: 'text' },
      { key: 'aiTokens', label: 'AI tokens in period', type: 'number' },
      { key: 'createdAt', label: 'Created', type: 'datetime' },
    ],
    rows: d.institutesTable.map((i) => ({
      name: i.name,
      status: humanize(i.status),
      plan: i.planName,
      subscription: i.subscriptionStatus && humanize(i.subscriptionStatus),
      endsAt: i.subscriptionEndsAt,
      branches: i.branches,
      users: i.users,
      students: i.students,
      teachers: i.teachers,
      storage: formatBytes(i.storageBytes),
      aiTokens: i.aiTokensInPeriod,
      createdAt: i.createdAt,
    })),
    totalRows: Math.max(d.institutes.total, d.institutesTable.length),
  };
}
