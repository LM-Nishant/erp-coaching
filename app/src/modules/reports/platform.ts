import {
  DEFAULT_INSTITUTE_TIMEZONE,
  REPORT_DATE_PRESETS,
  type ReportExportFormat,
  type ReportFilterOptionsDto,
  type ReportTableDto,
  type SaasDashboardDto,
} from '@erp/shared';
import { formatNumber } from '@/core/format';
import { i18n } from '@/i18n';
import { DEFAULT_PRESET, presetLabel, todayIn } from './filters';
import { formatBytes, humanize, keyLabel, type Metric } from './format';

const t = (key: string, params: Record<string, unknown> = {}) =>
  i18n.global.t(`reports.platform.${key}`, params);
const statusLabel = (status: string) => keyLabel('reports.platform.status', status);

/** SaaS figures are evaluated in the platform default timezone. */
export const PLATFORM_TIMEZONE = DEFAULT_INSTITUTE_TIMEZONE;

/** Period-only filter options for the platform pages (no tenant branches/courses/batches). */
export const platformFilterOptions = (now = new Date()): ReportFilterOptionsDto => ({
  timezone: PLATFORM_TIMEZONE,
  today: todayIn(PLATFORM_TIMEZONE, now),
  presets: REPORT_DATE_PRESETS.map((value) => ({ value, label: presetLabel(value) })),
  defaultPreset: DEFAULT_PRESET,
  branches: [],
  courses: [],
  batches: [],
  audience: 'management',
});

/** Same name the API sends (its `Content-Disposition` header isn't readable cross-origin). */
export const saasExportFileName = (d: Pick<SaasDashboardDto, 'period'>, format: ReportExportFormat) =>
  `saas-institutes-${d.period.from}-to-${d.period.to}.${format}`;

const count = (n: number) => formatNumber(n);

export function platformHeadline(d: SaasDashboardDto): Metric[] {
  return [
    {
      key: 'institutes',
      label: t('metrics.institutes'),
      value: d.institutes.total,
      type: 'number',
      hint: t('metrics.newInPeriod', { n: count(d.institutes.newInPeriod) }),
    },
    {
      key: 'users',
      label: t('metrics.users'),
      value: d.users.total,
      type: 'number',
      hint: t('metrics.activeNew', { active: count(d.users.active), new: count(d.users.newInPeriod) }),
    },
    {
      key: 'students',
      label: t('metrics.students'),
      value: d.students.total,
      type: 'number',
      hint: t('metrics.activeAdmitted', {
        active: count(d.students.active),
        admitted: count(d.students.admittedInPeriod),
      }),
    },
    { key: 'teachers', label: t('metrics.teachers'), value: d.teachers.total, type: 'number' },
    { key: 'branches', label: t('metrics.branches'), value: d.branches.total, type: 'number' },
  ];
}

export function platformSubscriptions(d: SaasDashboardDto): Metric[] {
  return [
    ...d.subscriptions.byStatus.map((s): Metric => ({
      key: `status-${s.status}`,
      label: statusLabel(s.status),
      value: s.count,
      type: 'number',
    })),
    {
      key: 'ending-soon',
      label: t('metrics.endingSoon'),
      value: d.subscriptions.endingSoon,
      type: 'number',
      tone: d.subscriptions.endingSoon ? 'warning' : undefined,
    },
  ];
}

export function platformRevenue(d: SaasDashboardDto): Metric[] {
  const r = d.revenue;
  const tracked = (key: string, label: string, paise: number | null): Metric =>
    paise === null
      ? { key, label, display: i18n.global.t('reports.units.notTracked') }
      : { key, label, value: paise, type: 'money' };
  return [
    { key: 'mrr', label: t('metrics.mrr'), value: r.mrrPaise, type: 'money' },
    { key: 'arr', label: t('metrics.arr'), value: r.arrPaise, type: 'money' },
    tracked('revenue', t('metrics.revenueInPeriod'), r.revenueInPeriodPaise),
    tracked('outstanding', t('metrics.outstanding'), r.outstandingPaise),
    { key: 'paid', label: t('metrics.paidSubscriptions'), value: r.paidSubscriptions, type: 'number' },
  ];
}

export const revenueNote = (d: SaasDashboardDto) =>
  d.revenue.source === 'subscriptions' ? t('revenueNote.subscriptions') : t('revenueNote.invoices');

export function platformUsage(d: SaasDashboardDto): Metric[] {
  return [
    {
      key: 'storage',
      label: t('metrics.storage'),
      display: formatBytes(d.usage.storageBytes),
      hint: t('metrics.files', { n: count(d.usage.files) }),
    },
    { key: 'ai-requests', label: t('metrics.aiRequests'), value: d.usage.aiRequestsInPeriod, type: 'number' },
    { key: 'ai-tokens', label: t('metrics.aiTokens'), value: d.usage.aiTokensInPeriod, type: 'number' },
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
    title: t('tables.plans'),
    columns: [
      { key: 'plan', label: t('tables.plan'), type: 'text' },
      { key: 'subscriptions', label: t('tables.subscriptions'), type: 'number' },
      { key: 'paying', label: t('tables.paying'), type: 'number' },
      { key: 'mrr', label: t('metrics.mrr'), type: 'money' },
    ],
    rows: list,
    totalRows: list.length,
  };
}

export function aiFeatureTable(d: SaasDashboardDto): ReportTableDto {
  return {
    key: 'ai-features',
    title: t('tables.aiFeatures'),
    columns: [
      { key: 'feature', label: t('tables.feature'), type: 'text' },
      { key: 'requests', label: t('tables.requests'), type: 'number' },
      { key: 'tokens', label: t('tables.tokens'), type: 'number' },
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
    title: t('tables.institutes'),
    columns: [
      { key: 'name', label: t('tables.institute'), type: 'text' },
      { key: 'status', label: i18n.global.t('common.labels.status'), type: 'text' },
      { key: 'plan', label: t('tables.plan'), type: 'text' },
      { key: 'subscription', label: t('tables.subscription'), type: 'text' },
      { key: 'endsAt', label: t('tables.endsAt'), type: 'datetime' },
      { key: 'branches', label: t('metrics.branches'), type: 'number' },
      { key: 'users', label: t('tables.users'), type: 'number' },
      { key: 'students', label: t('metrics.students'), type: 'number' },
      { key: 'teachers', label: t('metrics.teachers'), type: 'number' },
      { key: 'storage', label: t('tables.storage'), type: 'text' },
      { key: 'aiTokens', label: t('metrics.aiTokens'), type: 'number' },
      { key: 'createdAt', label: t('tables.created'), type: 'datetime' },
    ],
    rows: d.institutesTable.map((i) => ({
      name: i.name,
      status: statusLabel(i.status),
      plan: i.planName,
      subscription: i.subscriptionStatus && statusLabel(i.subscriptionStatus),
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
