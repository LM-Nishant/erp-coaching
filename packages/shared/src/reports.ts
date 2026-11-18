/**
 * Reports & analytics DTOs (spec §4.17 role dashboards and reports, §4.1 SaaS dashboard).
 * Money values are integer paise; percentages are 0–100 with one decimal.
 */

export const REPORT_KEYS = [
  'fee-collections',
  'outstanding-dues',
  'admissions',
  'capacity',
  'attendance',
  'exams',
  'teacher-performance',
  'payroll',
  'grievances',
  'appointments',
  'live-classes',
  'lms-engagement',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export type ReportCategory = 'finance' | 'academic' | 'operations' | 'staff';

export const REPORT_DATE_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'this_fy',
  'last_fy',
  'custom',
] as const;
export type ReportDatePreset = (typeof REPORT_DATE_PRESETS)[number];

export const REPORT_DATE_PRESET_LABELS: Record<ReportDatePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  this_year: 'This calendar year',
  this_fy: 'This financial year',
  last_fy: 'Last financial year',
  custom: 'Custom range',
};

/** Longest custom range accepted (days, inclusive). */
export const REPORT_MAX_RANGE_DAYS = 731;

export const REPORT_EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

export const REPORT_EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type ReportExportStatus = (typeof REPORT_EXPORT_STATUSES)[number];

/**
 * Who the report is computed for. `management` = institute/branch admins (scoped to their
 * branches), `finance` = accountants, `teacher` = own batches/classes, `student` = self,
 * `parent` = linked children.
 */
export type ReportAudience = 'management' | 'finance' | 'teacher' | 'student' | 'parent';

export type ReportFilterKind = 'date' | 'branch' | 'course' | 'batch';

/** Cell formatting hint: `money` = paise, `percent` = 0–100, `hours` = decimal hours. */
export type ReportColumnType = 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime' | 'hours';

export interface ReportColumnDto {
  key: string;
  label: string;
  type: ReportColumnType;
}

export type ReportCellValue = string | number | null;
export type ReportRowDto = Record<string, ReportCellValue>;

export interface ReportMetricDto {
  key: string;
  label: string;
  value: number | null;
  type: ReportColumnType;
  hint?: string;
  tone?: 'success' | 'warning' | 'danger' | 'medium';
}

export interface ReportTableDto {
  key: string;
  title: string;
  columns: ReportColumnDto[];
  rows: ReportRowDto[];
  /** Total rows before the detail limit; `rows.length < totalRows` means the table was truncated. */
  totalRows: number;
}

export interface ReportFiltersInput {
  preset?: ReportDatePreset;
  /** `YYYY-MM-DD`, institute-local; required with `custom`. */
  from?: string;
  to?: string;
  branchId?: number;
  courseId?: number;
  batchId?: number;
}

export interface ReportPeriodDto {
  preset: ReportDatePreset;
  /** Inclusive institute-local dates. */
  from: string;
  to: string;
  timezone: string;
  label: string;
}

export interface ReportAppliedFiltersDto {
  branchId: number | null;
  branchName: string | null;
  courseId: number | null;
  courseName: string | null;
  batchId: number | null;
  batchName: string | null;
}

export interface ReportScopeDto {
  audience: ReportAudience;
  /** Human-readable scope, e.g. "All branches", "Branch: Main", "Your children". */
  label: string;
}

export interface ReportCatalogItemDto {
  key: ReportKey;
  title: string;
  description: string;
  category: ReportCategory;
  filters: ReportFilterKind[];
  /** Plan module the underlying data belongs to. */
  planModule: string;
  /** True when the caller may export (has `reports.export`). */
  exportable: boolean;
}

export interface ReportResultDto {
  key: ReportKey;
  title: string;
  description: string;
  generatedAt: string;
  period: ReportPeriodDto;
  filters: ReportAppliedFiltersDto;
  scope: ReportScopeDto;
  summary: ReportMetricDto[];
  /** The first table is the detail table; the rest are breakdowns (by branch, by mode…). */
  tables: ReportTableDto[];
  notes: string[];
}

export interface ReportFilterOptionsDto {
  timezone: string;
  today: string;
  presets: { value: ReportDatePreset; label: string }[];
  defaultPreset: ReportDatePreset;
  branches: { id: number; name: string }[];
  courses: { id: number; name: string }[];
  batches: { id: number; name: string; branchId: number; courseId: number }[];
  audience: ReportAudience;
}

export interface CreateReportExportInput extends ReportFiltersInput {
  format: ReportExportFormat;
}

export interface ReportExportDto {
  id: number;
  reportKey: ReportKey;
  title: string;
  format: ReportExportFormat;
  status: ReportExportStatus;
  rowCount: number | null;
  fileName: string | null;
  error: string | null;
  filters: ReportFiltersInput;
  /** Period and scope resolved when the export was requested, e.g. "This month (1 Jan 2026 – 31 Jan 2026)". */
  periodLabel: string;
  scopeLabel: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
}

export interface ReportDownloadDto {
  url: string;
  expiresAt: string;
  fileName: string;
}

// ---------------------------------------------------------------- dashboards

export interface DashboardGroupDto {
  key: string;
  title: string;
  metrics: ReportMetricDto[];
}

/** Role dashboard (`GET /reports/dashboard`): institute, branch, accountant, teacher, student, parent. */
export interface RoleDashboardDto {
  audience: ReportAudience;
  title: string;
  scope: ReportScopeDto;
  period: ReportPeriodDto;
  groups: DashboardGroupDto[];
  /** Consolidated per-branch figures (management/finance only). */
  branches: ReportTableDto | null;
  /** Reports the caller can open, for shortcuts. */
  reports: ReportKey[];
}

/** SaaS billing figures; supplied by the billing module through `setSaasBillingStatsProvider`. */
export interface SaasBillingStatsDto {
  /** `subscriptions` = estimated from plan prices; `billing` = invoices/payments. */
  source: 'subscriptions' | 'billing';
  currency: 'INR';
  mrrPaise: number;
  arrPaise: number;
  /** Revenue collected in the period; null when not tracked. */
  revenueInPeriodPaise: number | null;
  /** Unpaid invoices; null when not tracked. */
  outstandingPaise: number | null;
  paidSubscriptions: number;
  byPlan: { planId: number; planName: string; subscriptions: number; mrrPaise: number }[];
}

export interface SaasInstituteRowDto {
  id: number;
  name: string;
  slug: string;
  status: string;
  planName: string | null;
  subscriptionStatus: string | null;
  subscriptionEndsAt: string | null;
  branches: number;
  users: number;
  students: number;
  teachers: number;
  storageBytes: number;
  aiTokensInPeriod: number;
  createdAt: string;
}

/** Super admin dashboard (`GET /admin/reports/dashboard`). */
export interface SaasDashboardDto {
  generatedAt: string;
  period: ReportPeriodDto;
  institutes: { total: number; newInPeriod: number; byStatus: { status: string; count: number }[] };
  users: { total: number; active: number; newInPeriod: number };
  students: { total: number; active: number; admittedInPeriod: number };
  teachers: { total: number };
  branches: { total: number };
  subscriptions: {
    byStatus: { status: string; count: number }[];
    byPlan: { planId: number; planName: string; count: number }[];
    /** Active/trial subscriptions ending within 30 days. */
    endingSoon: number;
  };
  revenue: SaasBillingStatsDto;
  usage: {
    storageBytes: number;
    files: number;
    aiTokensInPeriod: number;
    aiRequestsInPeriod: number;
    aiByFeature: { feature: string; requests: number; tokens: number }[];
  };
  institutesTable: SaasInstituteRowDto[];
}
