import type {
  AddonKind,
  AddonStatus,
  BillingCycle,
  MeteredMetric,
  PlanAddonPrice,
  PlanDto,
  PlanLimits,
  SaasInvoiceKind,
  SaasInvoiceStatus,
  SaasPaymentStatus,
  SubscriptionAccessState,
  SubscriptionAddonDto,
  SubscriptionStatusDto,
} from '@erp/shared';

export interface StatusChip {
  label: string;
  color: 'danger' | 'warning' | 'primary' | 'medium';
  detail: string | null;
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/**
 * Toolbar chip for the institute's subscription, or null when there is nothing to show this user.
 * Everyone sees the read-only and suspended states (they explain why actions fail); billing
 * managers also get trial, renewal and payment reminders.
 */
export function statusChip(s: SubscriptionStatusDto | null): StatusChip | null {
  if (!s) return null;
  const detail = s.message;
  switch (s.state) {
    case 'suspended':
      return { label: 'Suspended', color: 'danger', detail };
    case 'restricted':
      return { label: 'Read-only', color: 'danger', detail };
    case 'grace':
      return s.canManage ? { label: 'Payment due', color: 'warning', detail } : null;
    case 'trial':
      if (!s.canManage || s.daysLeft === null || s.daysLeft > 7) return null;
      return {
        label: s.daysLeft <= 0 ? 'Trial ends today' : `Trial: ${count(s.daysLeft, 'day')} left`,
        color: 'warning',
        detail,
      };
    case 'active':
      if (!s.canManage || !s.message) return null;
      return {
        label: s.daysLeft !== null && s.daysLeft <= 0 ? 'Renewal due today' : 'Renewal due',
        color: 'primary',
        detail,
      };
    case 'none':
      return s.canManage ? { label: 'No plan', color: 'medium', detail } : null;
  }
}

export const ACCESS_STATE_LABELS: Record<SubscriptionAccessState, string> = {
  none: 'No plan',
  trial: 'Trial',
  active: 'Active',
  grace: 'Grace period',
  restricted: 'Read-only',
  suspended: 'Suspended',
};

export const ACCESS_STATE_COLORS: Record<SubscriptionAccessState, string> = {
  none: 'medium',
  trial: 'tertiary',
  active: 'success',
  grace: 'warning',
  restricted: 'danger',
  suspended: 'danger',
};

export const INVOICE_KIND_LABELS: Record<SaasInvoiceKind, string> = {
  subscription: 'Subscription',
  renewal: 'Renewal',
  upgrade: 'Plan change',
  addon: 'Add-on',
  overage: 'Usage overage',
  manual: 'Manual',
};

export const INVOICE_STATUS_COLORS: Record<SaasInvoiceStatus, string> = {
  open: 'warning',
  paid: 'success',
  void: 'medium',
};

export const PAYMENT_STATUS_COLORS: Record<SaasPaymentStatus, string> = {
  pending: 'warning',
  success: 'success',
  failed: 'danger',
};

export const ADDON_STATUS_COLORS: Record<AddonStatus, string> = {
  pending: 'warning',
  active: 'success',
  cancelled: 'medium',
  expired: 'medium',
};

/** e.g. "2 × 50 students" or "lms module". */
export function addonSummary(a: Pick<SubscriptionAddonDto, 'kind' | 'quantity' | 'unitSize' | 'moduleKey'>) {
  const pack = packSize(a.kind, a.unitSize, a.moduleKey);
  return a.kind === 'module' || a.quantity === 1 ? pack : `${a.quantity} × ${pack}`;
}

/** Usage meter colour: unlimited is neutral, 80% warns, the limit (or beyond) is danger. */
export function meterColor(percent: number | null): 'primary' | 'warning' | 'danger' | 'medium' {
  if (percent === null) return 'medium';
  if (percent >= 100) return 'danger';
  if (percent >= 80) return 'warning';
  return 'primary';
}

/** Progress bar value in [0, 1]; unlimited metrics show an empty bar. */
export const meterValue = (percent: number | null) =>
  percent === null ? 0 : Math.min(1, Math.max(0, percent / 100));

const round1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-IN');

export const formatMb = (mb: number) => (mb >= 1024 ? `${round1(mb / 1024)} GB` : `${round1(mb)} MB`);

/** A metric value for display: storage in MB/GB, counts with Indian digit grouping. */
export function formatMetric(metric: MeteredMetric, value: number | null): string {
  if (value === null) return 'Unlimited';
  return metric === 'storageMb' ? formatMb(value) : value.toLocaleString('en-IN');
}

/** Size of one add-on pack or overage block, e.g. "10 students", "1 GB", "100,000 AI tokens". */
export function packSize(kind: AddonKind | MeteredMetric, n: number, moduleKey?: string | null): string {
  switch (kind) {
    case 'students':
      return count(n, 'student');
    case 'branches':
      return count(n, 'branch', 'branches');
    case 'teachers':
      return count(n, 'teacher');
    case 'storage':
    case 'storageMb':
      return formatMb(n);
    case 'ai_credits':
    case 'aiTokens':
      return count(n, 'AI token');
    case 'module':
      return `${moduleKey ?? 'extra'} module`;
  }
}

/** Price of one add-on pack for the subscription's cycle (mirrors the API's `addonPrice`). */
export function addonCyclePrice(entry: PlanAddonPrice, cycle: BillingCycle): number {
  if (entry.kind === 'ai_credits' || cycle === 'monthly') return entry.monthlyPricePaise;
  return entry.yearlyPricePaise || entry.monthlyPricePaise * 12;
}

type PricedPlan = Pick<PlanDto, 'priceMonthlyPaise' | 'priceYearlyPaise'>;

export const planPrice = (plan: PricedPlan, cycle: BillingCycle) =>
  cycle === 'yearly' ? plan.priceYearlyPaise : plan.priceMonthlyPaise;

/** A cycle is offered unless only the other one is priced (mirrors the API's `assertCycleOffered`). */
export function cycleOffered(plan: PricedPlan, cycle: BillingCycle): boolean {
  return planPrice(plan, cycle) > 0 || planPrice(plan, cycle === 'yearly' ? 'monthly' : 'yearly') === 0;
}

/** One-line plan limits, e.g. "500 students · 3 branches · 20 teachers · 5 GB storage · No AI". */
export function limitsSummary(l: PlanLimits): string {
  const seats = (v: number | null, kind: 'students' | 'branches' | 'teachers') =>
    v === null ? `Unlimited ${kind}` : packSize(kind, v);
  return [
    seats(l.maxStudents, 'students'),
    seats(l.maxBranches, 'branches'),
    seats(l.maxTeachers, 'teachers'),
    l.storageMb === null ? 'Unlimited storage' : `${formatMb(l.storageMb)} storage`,
    l.aiTokensMonthly === null
      ? 'Unlimited AI'
      : l.aiTokensMonthly === 0
        ? 'No AI'
        : `${packSize('aiTokens', l.aiTokensMonthly)}/month`,
  ].join(' · ');
}

/** Rupees typed in a form → paise. */
export const toPaise = (rupees: number | string) => Math.round(Number(rupees) * 100);

const DAY_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

export const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', DAY_FORMAT) : '—';

export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN') : '—';

/** `YYYY-MM-DD` values (invoice issue/due dates) are calendar days, not instants. */
export function formatDay(day: string | null | undefined): string {
  if (!day) return '—';
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', DAY_FORMAT);
}
