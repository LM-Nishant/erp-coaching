import {
  DEFAULT_INSTITUTE_TIMEZONE,
  type ReportFiltersInput,
  type SaasBillingStatsDto,
  type SaasDashboardDto,
  type SaasInstituteRowDto,
} from '@erp/shared';
import { logger } from '../../infrastructure/logger';
import { isoInstant, num, reportQuery, utcSql } from '../../shared/reporting';
import { platformStudentCounts } from '../students/api';
import { periodDto, resolvePeriod } from './filters';
import type { ReportDocument } from './render';

/**
 * SaaS-wide figures for the super admin dashboard (spec §4.1). These queries read across every
 * tenant on purpose, so they are only reachable from the super-admin `/admin/reports` routes.
 */

/** Period handed to the billing stats provider (`[start, end)` UTC, inclusive local dates). */
export interface SaasPeriod {
  from: string;
  to: string;
  start: Date;
  end: Date;
  timezone: string;
}

export type SaasBillingStatsProvider = (period: SaasPeriod) => Promise<SaasBillingStatsDto>;

let billingProvider: SaasBillingStatsProvider | null = null;

/**
 * Lets the SaaS billing module supply revenue, invoice and outstanding figures. Without a provider
 * (or if it fails) the dashboard estimates recurring revenue from current subscriptions and plan prices.
 */
export function setSaasBillingStatsProvider(provider: SaasBillingStatsProvider | null): void {
  billingProvider = provider;
}

const PAID_STATUSES = ['active', 'past_due'];
const LIVE_STATUSES = ['trial', 'active', 'past_due'];
const INSTITUTE_TABLE_LIMIT = 1000;
const ENDING_SOON_DAYS = 30;

interface CurrentSubscription {
  instituteId: number;
  planId: number;
  planName: string;
  status: string;
  billingCycle: string;
  endsAt: Date | null;
  monthlyPaise: number;
}

/**
 * Each institute's current subscription, using the same rule as `getActiveSubscription` (live status,
 * started, not ended; latest start first), else its latest started one. Live subscriptions past their
 * end date are reported as `expired`.
 */
async function currentSubscriptions(): Promise<CurrentSubscription[]> {
  const rows = await reportQuery<Record<string, unknown>>(
    `SELECT x.* FROM (
       SELECT s.institute_id, s.plan_id, s.status, s.billing_cycle, s.ends_at, p.name plan_name,
         p.price_monthly_paise, p.price_yearly_paise,
         ROW_NUMBER() OVER (PARTITION BY s.institute_id ORDER BY
           (s.status IN (:live) AND (s.ends_at IS NULL OR s.ends_at > UTC_TIMESTAMP())) DESC,
           s.starts_at DESC, s.id DESC) rn
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.starts_at <= UTC_TIMESTAMP()
     ) x WHERE x.rn = 1`,
    { live: LIVE_STATUSES },
  );
  const now = Date.now();
  return rows.map((r) => {
    const endsAt = r.ends_at ? new Date(isoInstant(r.ends_at)!) : null;
    const status = String(r.status);
    const yearly = r.billing_cycle === 'yearly';
    return {
      instituteId: num(r.institute_id),
      planId: num(r.plan_id),
      planName: String(r.plan_name ?? ''),
      status: LIVE_STATUSES.includes(status) && endsAt && endsAt.getTime() <= now ? 'expired' : status,
      billingCycle: String(r.billing_cycle),
      endsAt,
      monthlyPaise: yearly ? Math.round(num(r.price_yearly_paise) / 12) : num(r.price_monthly_paise),
    };
  });
}

/** Default billing figures: monthly recurring revenue estimated from paid subscriptions' plan prices. */
function estimateBillingStats(subscriptions: CurrentSubscription[]): SaasBillingStatsDto {
  const paid = subscriptions.filter((s) => PAID_STATUSES.includes(s.status) && s.monthlyPaise > 0);
  const byPlan = new Map<number, SaasBillingStatsDto['byPlan'][number]>();
  for (const s of paid) {
    const p = byPlan.get(s.planId) ?? {
      planId: s.planId,
      planName: s.planName,
      subscriptions: 0,
      mrrPaise: 0,
    };
    p.subscriptions++;
    p.mrrPaise += s.monthlyPaise;
    byPlan.set(s.planId, p);
  }
  const mrrPaise = paid.reduce((n, s) => n + s.monthlyPaise, 0);
  return {
    source: 'subscriptions',
    currency: 'INR',
    mrrPaise,
    arrPaise: mrrPaise * 12,
    revenueInPeriodPaise: null,
    outstandingPaise: null,
    paidSubscriptions: paid.length,
    byPlan: [...byPlan.values()].sort(
      (a, b) => b.mrrPaise - a.mrrPaise || a.planName.localeCompare(b.planName),
    ),
  };
}

async function billingStats(period: SaasPeriod, subscriptions: CurrentSubscription[]) {
  if (billingProvider) {
    try {
      return await billingProvider(period);
    } catch (err) {
      logger.warn({ err }, 'SaaS billing stats provider failed; estimating from subscriptions');
    }
  }
  return estimateBillingStats(subscriptions);
}

const countBy = (rows: Record<string, unknown>[], key = 'institute_id', value = 'n') =>
  new Map(rows.map((r) => [num(r[key]), num(r[value])]));

/** SaaS-wide dashboard; the period is evaluated in the platform default timezone. */
export async function saasDashboard(
  input: ReportFiltersInput,
  opts: { tableLimit?: number } = {},
): Promise<SaasDashboardDto> {
  const period = resolvePeriod(input, DEFAULT_INSTITUTE_TIMEZONE);
  const range = { start: utcSql(period.start), end: utcSql(period.end) };
  const [institutes, subscriptions, branches, members, teachers, users, files, ai, students] =
    await Promise.all([
      reportQuery<Record<string, unknown>>(
        'SELECT id, name, slug, status, created_at FROM institutes ORDER BY name, id',
        {},
      ),
      currentSubscriptions(),
      reportQuery<Record<string, unknown>>(
        'SELECT institute_id, COUNT(*) n FROM branches GROUP BY institute_id',
        {},
      ),
      reportQuery<Record<string, unknown>>(
        'SELECT institute_id, COUNT(DISTINCT user_id) n FROM user_roles GROUP BY institute_id',
        {},
      ),
      reportQuery<Record<string, unknown>>(
        `SELECT ur.institute_id, COUNT(DISTINCT ur.user_id) n FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id WHERE r.slug = 'teacher' GROUP BY ur.institute_id`,
        {},
      ),
      reportQuery<Record<string, unknown>>(
        `SELECT COUNT(*) total, SUM(status = 'active') active,
           SUM(created_at >= :start AND created_at < :end) new_users
         FROM users WHERE is_super_admin = 0`,
        range,
      ),
      reportQuery<Record<string, unknown>>(
        'SELECT institute_id, COUNT(*) files, SUM(size_bytes) bytes FROM files GROUP BY institute_id',
        {},
      ),
      reportQuery<Record<string, unknown>>(
        `SELECT institute_id, feature, COUNT(*) requests, SUM(total_tokens) tokens FROM ai_usage
         WHERE created_at >= :start AND created_at < :end GROUP BY institute_id, feature`,
        range,
      ),
      platformStudentCounts(period),
    ]);

  const subsByInstitute = new Map(subscriptions.map((s) => [s.instituteId, s]));
  const branchCounts = countBy(branches);
  const memberCounts = countBy(members);
  const teacherCounts = countBy(teachers);
  const storage = new Map(files.map((r) => [num(r.institute_id), num(r.bytes)]));
  const studentCounts = new Map(students.map((s) => [s.instituteId, s]));
  const aiTokens = new Map<number, number>();
  const aiFeatures = new Map<string, { feature: string; requests: number; tokens: number }>();
  for (const r of ai) {
    const id = num(r.institute_id);
    aiTokens.set(id, (aiTokens.get(id) ?? 0) + num(r.tokens));
    const feature = String(r.feature);
    const f = aiFeatures.get(feature) ?? { feature, requests: 0, tokens: 0 };
    f.requests += num(r.requests);
    f.tokens += num(r.tokens);
    aiFeatures.set(feature, f);
  }

  const tally = (values: string[]) => {
    const m = new Map<string, number>();
    for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
  };
  const instituteIds = new Set(institutes.map((i) => num(i.id)));
  const startedAt = period.start.getTime();
  const endAt = period.end.getTime();
  const created = (v: unknown) => {
    const t = new Date(isoInstant(v) ?? 0).getTime();
    return t >= startedAt && t < endAt;
  };
  const now = Date.now();
  const soon = now + ENDING_SOON_DAYS * 86_400_000;
  const live = subscriptions.filter(
    (s) => instituteIds.has(s.instituteId) && LIVE_STATUSES.includes(s.status),
  );
  const byPlan = new Map<number, { planId: number; planName: string; count: number }>();
  for (const s of live) {
    const p = byPlan.get(s.planId) ?? { planId: s.planId, planName: s.planName, count: 0 };
    p.count++;
    byPlan.set(s.planId, p);
  }

  const table: SaasInstituteRowDto[] = institutes
    .slice(0, opts.tableLimit ?? INSTITUTE_TABLE_LIMIT)
    .map((i) => {
      const id = num(i.id);
      const sub = subsByInstitute.get(id);
      return {
        id,
        name: String(i.name),
        slug: String(i.slug),
        status: String(i.status),
        planName: sub?.planName ?? null,
        subscriptionStatus: sub?.status ?? null,
        subscriptionEndsAt: sub?.endsAt?.toISOString() ?? null,
        branches: branchCounts.get(id) ?? 0,
        users: memberCounts.get(id) ?? 0,
        students: studentCounts.get(id)?.total ?? 0,
        teachers: teacherCounts.get(id) ?? 0,
        storageBytes: storage.get(id) ?? 0,
        aiTokensInPeriod: aiTokens.get(id) ?? 0,
        createdAt: isoInstant(i.created_at) ?? '',
      };
    });

  const [u] = users;
  return {
    generatedAt: new Date().toISOString(),
    period: periodDto(period),
    institutes: {
      total: institutes.length,
      newInPeriod: institutes.filter((i) => created(i.created_at)).length,
      byStatus: tally(institutes.map((i) => String(i.status))),
    },
    users: { total: num(u?.total), active: num(u?.active), newInPeriod: num(u?.new_users) },
    students: {
      total: students.reduce((n, s) => n + s.total, 0),
      active: students.reduce((n, s) => n + s.active, 0),
      admittedInPeriod: students.reduce((n, s) => n + s.admitted, 0),
    },
    teachers: { total: [...teacherCounts.values()].reduce((n, v) => n + v, 0) },
    branches: { total: [...branchCounts.values()].reduce((n, v) => n + v, 0) },
    subscriptions: {
      byStatus: tally(institutes.map((i) => subsByInstitute.get(num(i.id))?.status ?? 'none')),
      byPlan: [...byPlan.values()].sort((a, b) => b.count - a.count || a.planName.localeCompare(b.planName)),
      endingSoon: live.filter(
        (s) => (s.status === 'active' || s.status === 'trial') && s.endsAt && s.endsAt.getTime() <= soon,
      ).length,
    },
    revenue: await billingStats(
      { from: period.from, to: period.to, start: period.start, end: period.end, timezone: period.timezone },
      subscriptions.filter((s) => instituteIds.has(s.instituteId)),
    ),
    usage: {
      storageBytes: files.reduce((n, r) => n + num(r.bytes), 0),
      files: files.reduce((n, r) => n + num(r.files), 0),
      aiTokensInPeriod: [...aiFeatures.values()].reduce((n, f) => n + f.tokens, 0),
      aiRequestsInPeriod: [...aiFeatures.values()].reduce((n, f) => n + f.requests, 0),
      aiByFeature: [...aiFeatures.values()].sort((a, b) => b.tokens - a.tokens),
    },
    institutesTable: table,
  };
}

const MB = 1024 * 1024;
const megabytes = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

/** The SaaS dashboard as an exportable document: platform metrics plus per-institute rows. */
export function saasExportDocument(dash: SaasDashboardDto): ReportDocument {
  const { revenue, usage } = dash;
  const estimated = revenue.source === 'subscriptions';
  return {
    key: 'saas-institutes',
    title: 'Platform overview',
    description: 'Institutes, users, subscriptions, revenue and resource usage across the platform.',
    generatedAt: dash.generatedAt,
    period: dash.period,
    filters: {
      branchId: null,
      branchName: null,
      courseId: null,
      courseName: null,
      batchId: null,
      batchName: null,
    },
    scope: { audience: 'management', label: 'All institutes' },
    summary: [
      { key: 'institutes', label: 'Institutes', value: dash.institutes.total, type: 'number' },
      { key: 'newInstitutes', label: 'New institutes', value: dash.institutes.newInPeriod, type: 'number' },
      { key: 'users', label: 'Users', value: dash.users.total, type: 'number' },
      { key: 'activeStudents', label: 'Active students', value: dash.students.active, type: 'number' },
      { key: 'teachers', label: 'Teachers', value: dash.teachers.total, type: 'number' },
      { key: 'branches', label: 'Branches', value: dash.branches.total, type: 'number' },
      { key: 'paid', label: 'Paid subscriptions', value: revenue.paidSubscriptions, type: 'number' },
      {
        key: 'mrr',
        label: 'Monthly recurring revenue',
        value: revenue.mrrPaise,
        type: 'money',
        hint: estimated ? 'estimated from plan prices' : undefined,
      },
      { key: 'arr', label: 'Annual run rate', value: revenue.arrPaise, type: 'money' },
      { key: 'revenue', label: 'Revenue in period', value: revenue.revenueInPeriodPaise, type: 'money' },
      { key: 'outstanding', label: 'Outstanding invoices', value: revenue.outstandingPaise, type: 'money' },
      { key: 'storage', label: 'Storage used (MB)', value: megabytes(usage.storageBytes), type: 'number' },
      { key: 'aiTokens', label: 'AI tokens in period', value: usage.aiTokensInPeriod, type: 'number' },
      { key: 'aiRequests', label: 'AI requests in period', value: usage.aiRequestsInPeriod, type: 'number' },
    ],
    tables: [
      {
        key: 'institutes',
        title: 'Institutes',
        columns: [
          { key: 'name', label: 'Institute', type: 'text' },
          { key: 'slug', label: 'Slug', type: 'text' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'planName', label: 'Plan', type: 'text' },
          { key: 'subscriptionStatus', label: 'Subscription', type: 'text' },
          { key: 'subscriptionEndsAt', label: 'Subscription ends', type: 'datetime' },
          { key: 'branches', label: 'Branches', type: 'number' },
          { key: 'users', label: 'Users', type: 'number' },
          { key: 'students', label: 'Students', type: 'number' },
          { key: 'teachers', label: 'Teachers', type: 'number' },
          { key: 'storageMb', label: 'Storage (MB)', type: 'number' },
          { key: 'aiTokensInPeriod', label: 'AI tokens in period', type: 'number' },
          { key: 'createdAt', label: 'Created', type: 'datetime' },
        ],
        rows: dash.institutesTable.map((i) => ({
          name: i.name,
          slug: i.slug,
          status: i.status,
          planName: i.planName,
          subscriptionStatus: i.subscriptionStatus ?? 'none',
          subscriptionEndsAt: i.subscriptionEndsAt,
          branches: i.branches,
          users: i.users,
          students: i.students,
          teachers: i.teachers,
          storageMb: megabytes(i.storageBytes),
          aiTokensInPeriod: i.aiTokensInPeriod,
          createdAt: i.createdAt,
        })),
        totalRows: dash.institutes.total,
      },
      {
        key: 'plans',
        title: 'Revenue by plan',
        columns: [
          { key: 'planName', label: 'Plan', type: 'text' },
          { key: 'subscriptions', label: 'Paid subscriptions', type: 'number' },
          { key: 'mrrPaise', label: 'Monthly recurring revenue', type: 'money' },
        ],
        rows: revenue.byPlan.map((p) => ({
          planName: p.planName,
          subscriptions: p.subscriptions,
          mrrPaise: p.mrrPaise,
        })),
        totalRows: revenue.byPlan.length,
      },
      {
        key: 'subscriptions',
        title: 'Subscriptions by status',
        columns: [
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'count', label: 'Institutes', type: 'number' },
        ],
        rows: dash.subscriptions.byStatus.map((s) => ({ status: s.status, count: s.count })),
        totalRows: dash.subscriptions.byStatus.length,
      },
      {
        key: 'ai',
        title: 'AI usage by feature',
        columns: [
          { key: 'feature', label: 'Feature', type: 'text' },
          { key: 'requests', label: 'Requests', type: 'number' },
          { key: 'tokens', label: 'Tokens', type: 'number' },
        ],
        rows: usage.aiByFeature.map((f) => ({ feature: f.feature, requests: f.requests, tokens: f.tokens })),
        totalRows: usage.aiByFeature.length,
      },
    ],
    notes: [
      estimated
        ? 'Recurring revenue is estimated from current subscriptions and plan prices; yearly plans count as one twelfth per month. Revenue and outstanding invoices are not tracked yet.'
        : 'Revenue figures come from SaaS billing (invoices and payments).',
      `Subscriptions ending within 30 days: ${dash.subscriptions.endingSoon}.`,
    ],
  };
}
