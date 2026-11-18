/** SaaS billing (spec §4.1): plans, subscription lifecycle, usage metering, invoices and payments. */
import type { PlanLimits, SubscriptionStatus } from './plans';

export type BillingCycle = 'monthly' | 'yearly';

/**
 * Effective access derived from the current subscription and the billing policy:
 * trial/active = full access; grace = full access with a warning after the period ended;
 * restricted = read-only; suspended = only billing pages; none = no subscription.
 */
export type SubscriptionAccessState = 'none' | 'trial' | 'active' | 'grace' | 'restricted' | 'suspended';

/** Error codes returned (HTTP 402) by the API while an institute is restricted or suspended. */
export const SUBSCRIPTION_ERROR_CODES = {
  RESTRICTED: 'SUBSCRIPTION_RESTRICTED',
  SUSPENDED: 'SUBSCRIPTION_SUSPENDED',
} as const;

export const METERED_METRICS = ['students', 'branches', 'teachers', 'storageMb', 'aiTokens'] as const;
export type MeteredMetric = (typeof METERED_METRICS)[number];

type NumericLimitKey = Exclude<keyof PlanLimits, 'enabledModules'>;

/** Plan limit that caps each metered metric. */
export const METRIC_LIMIT_KEY: Record<MeteredMetric, NumericLimitKey> = {
  students: 'maxStudents',
  branches: 'maxBranches',
  teachers: 'maxTeachers',
  storageMb: 'storageMb',
  aiTokens: 'aiTokensMonthly',
};

export const METRIC_LABELS: Record<MeteredMetric, string> = {
  students: 'Students',
  branches: 'Branches',
  teachers: 'Teachers',
  storageMb: 'Storage (MB)',
  aiTokens: 'AI tokens this month',
};

export const ADDON_KINDS = ['students', 'branches', 'teachers', 'storage', 'ai_credits', 'module'] as const;
export type AddonKind = (typeof ADDON_KINDS)[number];

/** Limit raised by each add-on kind (`module` adds to `enabledModules`). */
export const ADDON_LIMIT_KEY: Record<Exclude<AddonKind, 'module'>, NumericLimitKey> = {
  students: 'maxStudents',
  branches: 'maxBranches',
  teachers: 'maxTeachers',
  storage: 'storageMb',
  ai_credits: 'aiTokensMonthly',
};

export const ADDON_LABELS: Record<AddonKind, string> = {
  students: 'Extra students',
  branches: 'Extra branches',
  teachers: 'Extra teachers',
  storage: 'Extra storage (MB)',
  ai_credits: 'AI credit pack (tokens, this month)',
  module: 'Extra module',
};

/**
 * Plan catalogue entry for a purchasable add-on pack. Recurring add-ons (everything except
 * `ai_credits`) renew with the subscription; AI credits are one-time packs for the current month.
 */
export interface PlanAddonPrice {
  kind: AddonKind;
  /** Units per pack: students/branches/teachers, storage MB or AI tokens. 1 for modules. */
  unitSize: number;
  /** Per pack per month (recurring) or per pack (AI credits). */
  monthlyPricePaise: number;
  /** Per pack per year, for yearly subscriptions (recurring only). */
  yearlyPricePaise: number;
  /** Module id unlocked by a `module` add-on (e.g. `lms`). */
  moduleKey?: string | null;
}

/**
 * Overage pricing: usage above the included limit is billed monthly in arrears instead of being
 * blocked (soft limit). Seat metrics bill the month's peak, AI tokens the month's total.
 */
export interface OveragePrice {
  /** Units per billed block, e.g. 1 student, 1024 MB, 100000 tokens. */
  unitSize: number;
  pricePaise: number;
  /** Extra units allowed above the included limit before requests are blocked; null = no cap. */
  maxOverage?: number | null;
}
export type PlanUsagePricing = Partial<Record<MeteredMetric, OveragePrice>>;

export interface PlanDto {
  id: number;
  code: string;
  name: string;
  description: string | null;
  priceMonthlyPaise: number;
  priceYearlyPaise: number;
  trialDays: number;
  limits: PlanLimits;
  addons: PlanAddonPrice[];
  usagePricing: PlanUsagePricing;
  isActive: boolean;
  activeSubscriptions?: number;
}

/** `GET /subscription/status`: minimal state for the app banner (any institute member). */
export interface SubscriptionStatusDto {
  state: SubscriptionAccessState;
  planName: string | null;
  /** End of the trial or paid period; null = open-ended. */
  endsAt: string | null;
  /** Grace end (restricted/suspended access starts after it). */
  graceEndsAt: string | null;
  /** When a restricted institute is suspended; null = never. */
  suspendsAt: string | null;
  /** Whole days until the next state change (trial/active: endsAt, grace: graceEndsAt). */
  daysLeft: number | null;
  /** The caller may pay, renew or change the plan (`subscription.edit`). */
  canManage: boolean;
  message: string | null;
}

export interface SubscriptionDto {
  id: number;
  instituteId: number;
  planId: number;
  plan?: { id: number; code: string; name: string } | null;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  startsAt: string;
  endsAt: string | null;
  currentPeriodStart: string | null;
  pendingPlanId: number | null;
  pendingPlan?: { id: number; code: string; name: string } | null;
  pendingBillingCycle: BillingCycle | null;
  suspendedAt: string | null;
  suspendReason: string | null;
  trialExtendedDays: number;
  limitOverrides: Partial<PlanLimits> | null;
  createdAt: string;
}

export type AddonStatus = 'pending' | 'active' | 'cancelled' | 'expired';

export interface SubscriptionAddonDto {
  id: number;
  kind: AddonKind;
  moduleKey: string | null;
  quantity: number;
  unitSize: number;
  /** Price per pack per billing cycle (AI credits: per pack). */
  unitPricePaise: number;
  billingCycle: BillingCycle;
  status: AddonStatus;
  cancelAtPeriodEnd: boolean;
  startsAt: string | null;
  /** Month (`YYYY-MM-01`) an AI credit pack applies to. */
  periodMonth: string | null;
  invoiceId: number | null;
  createdAt: string;
}

export interface UsageMetricDto {
  metric: MeteredMetric;
  label: string;
  used: number;
  /** Plan + add-ons (+ overrides); null = unlimited. */
  included: number | null;
  remaining: number | null;
  /** used / included × 100, rounded; null when unlimited. */
  percent: number | null;
  /** Overage pricing when the limit is soft. */
  overage: OveragePrice | null;
}

export interface AiQuotaDto {
  usedThisMonth: number;
  /** Plan allowance + AI credit packs bought this month; null = unlimited. */
  includedThisMonth: number | null;
  creditsThisMonth: number;
  remaining: number | null;
  requestsThisMonth: number;
  byFeature: { feature: string; tokens: number; requests: number }[];
  /** Overage pricing when AI usage beyond the allowance is billed instead of blocked. */
  overage: OveragePrice | null;
}

export interface BillingPolicyDto {
  /** Days of full access after a paid period ends. */
  graceDays: number;
  /** Days of full access after a trial ends. */
  trialGraceDays: number;
  /** Access after the grace period. */
  afterGrace: 'restricted' | 'suspended';
  /** Days after grace before a restricted institute is suspended; null = never. */
  suspendAfterDays: number | null;
  /** Renewal invoices are issued this many days before the period ends. */
  renewalLeadDays: number;
  /** Due date offset for upgrade, add-on, overage and manual invoices. */
  invoiceDueDays: number;
}

export interface BillingProfileDto {
  legalName: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  /** Used for intra-state (CGST + SGST) vs inter-state (IGST) GST. */
  state: string | null;
  pincode: string | null;
  email: string | null;
  phone: string | null;
  /** Invoice number prefix, e.g. `SAAS` → `SAAS/25-26/000001`. */
  invoicePrefix: string;
  creditNotePrefix: string;
  /** SAC code printed on invoice lines (default 998315: hosting and IT infrastructure provisioning). */
  sacCode: string;
  /** GST rate in percent; 0 disables tax. */
  gstRatePercent: number;
}

export interface BillingOverviewDto {
  status: SubscriptionStatusDto;
  subscription: SubscriptionDto | null;
  plan: PlanDto | null;
  /** False for open-ended (platform-managed) subscriptions: plan changes and add-ons go through support. */
  selfService: boolean;
  /** Included limits (plan + add-ons + overrides). */
  limits: PlanLimits | null;
  usage: UsageMetricDto[];
  ai: AiQuotaDto;
  addons: SubscriptionAddonDto[];
  /** Add-on packs the current plan offers. */
  addonCatalogue: PlanAddonPrice[];
  plans: PlanDto[];
  openInvoices: SaasInvoiceDto[];
  policy: BillingPolicyDto;
  /** GST rate applied to new invoices. */
  gstRatePercent: number;
}

export type SaasInvoiceKind = 'subscription' | 'renewal' | 'upgrade' | 'addon' | 'overage' | 'manual';
export type SaasInvoiceStatus = 'open' | 'paid' | 'void';

export interface BilledPartyDto {
  name: string;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
}

export interface SaasInvoiceLineDto {
  id?: number;
  description: string;
  sacCode: string | null;
  quantity: number;
  unitPricePaise: number;
  amountPaise: number;
}

export interface SaasInvoiceDto {
  id: number;
  number: string;
  instituteId: number | null;
  instituteName: string;
  kind: SaasInvoiceKind;
  status: SaasInvoiceStatus;
  issueDate: string;
  dueDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  creditedPaise: number;
  paidPaise: number;
  /** total − credited − paid. */
  balancePaise: number;
  billedTo: BilledPartyDto;
  seller: BilledPartyDto & { email: string | null; phone: string | null };
  lines?: SaasInvoiceLineDto[];
  notes: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

export type SaasPaymentMethod = 'gateway' | 'manual';
export type SaasPaymentStatus = 'pending' | 'success' | 'failed';

export interface SaasPaymentDto {
  id: number;
  instituteId: number | null;
  instituteName: string;
  invoiceId: number | null;
  invoiceNumber: string | null;
  amountPaise: number;
  method: SaasPaymentMethod;
  gateway: string | null;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  status: SaasPaymentStatus;
  /** Bank / UTR / cheque reference for manual payments. */
  reference: string | null;
  note: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface SaasCreditNoteDto {
  id: number;
  number: string;
  instituteId: number | null;
  instituteName: string;
  invoiceId: number;
  invoiceNumber: string;
  /** Credited amount including tax. */
  amountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  reason: string;
  createdAt: string;
}

/** Invoice with its payments and credit notes. */
export interface SaasInvoiceDetailDto {
  invoice: SaasInvoiceDto;
  payments: SaasPaymentDto[];
  creditNotes: SaasCreditNoteDto[];
}

export interface PlanChangePreviewDto {
  /** `trial` = plan switch during the free trial (no charge). */
  kind: 'upgrade' | 'downgrade' | 'trial' | 'same';
  effective: 'now' | 'period_end';
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  /** Term after the change. */
  periodStart: string | null;
  periodEnd: string | null;
  /** Downgrades are refused while usage exceeds the target plan's limits. */
  blockedBy: { metric: MeteredMetric; used: number; limit: number }[];
  message: string;
}

/** Result of starting a checkout for an invoice. */
export interface SaasCheckoutDto {
  invoice: SaasInvoiceDto;
  payment: SaasPaymentDto;
  gateway: string;
  /** Gateway specific data for the client checkout (mock: simulated hosted page). */
  checkout: Record<string, unknown>;
}

/** Result of a plan change, add-on purchase or renewal request. */
export interface BillingActionResultDto {
  /** Applied immediately (trial switch, scheduled downgrade, free change). */
  applied: boolean;
  /** Invoice to pay to apply the change (upgrade, add-on, renewal). */
  invoice: SaasInvoiceDto | null;
  message: string;
}

export interface UsageSnapshotDto {
  snapshotDate: string;
  students: number;
  branches: number;
  teachers: number;
  storageMb: number;
  aiTokensMonth: number;
}

/** Super admin subscriptions list row. */
export interface AdminSubscriptionRowDto {
  instituteId: number;
  instituteName: string;
  instituteSlug: string;
  instituteStatus: string;
  subscription: SubscriptionDto | null;
  state: SubscriptionAccessState;
  graceEndsAt: string | null;
  openBalancePaise: number;
}

/** Reports hand-off: revenue per month (paid invoices / successful payments). */
export interface RevenuePointDto {
  month: string;
  invoicedPaise: number;
  collectedPaise: number;
  creditedPaise: number;
}

// ------------------------------------------------------------------ platform configuration

export const STORAGE_DRIVERS = ['local', 's3', 'r2'] as const;
export type StorageDriverKey = (typeof STORAGE_DRIVERS)[number];

/**
 * Result of the last connection test. A configuration can be enabled (activated) only after it
 * passes a test; changing its connection settings or credentials resets the result.
 */
export interface IntegrationTestStatus {
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

/** Global payment gateway used for SaaS billing (and optionally as the institutes' fee fallback). */
export interface PlatformGatewayDto extends IntegrationTestStatus {
  gateway: string;
  enabled: boolean;
  /** Gateway used for SaaS subscription payments. */
  isDefault: boolean;
  /** Offered to institutes that have no enabled fee gateway of their own. */
  useForInstitutes: boolean;
  sandbox: boolean;
  merchantId: string | null;
  hasSecret: boolean;
  keyHint: string | null;
  hasWebhookSecret: boolean;
  /** SaaS subscription payment webhook to register with the gateway. */
  webhookUrl: string;
  updatedAt: string | null;
}

export interface PlatformGatewayInput {
  enabled: boolean;
  isDefault: boolean;
  useForInstitutes: boolean;
  sandbox: boolean;
  merchantId?: string | null;
  /** Blank/omitted keeps the stored secret. */
  secretKey?: string;
  webhookSecret?: string;
}

/** Global default notification provider per channel (institute providers take precedence). */
export interface PlatformMessagingDto extends IntegrationTestStatus {
  channel: 'sms' | 'whatsapp' | 'email' | 'push';
  provider: string;
  enabled: boolean;
  settings: Record<string, string>;
  /** Masked hints of saved secret fields. */
  secretHints: Record<string, string>;
  /** False when nothing is saved: the built-in console provider is the default. */
  configured: boolean;
  updatedAt: string | null;
}

export interface PlatformMessagingInput {
  provider: string;
  enabled: boolean;
  /** Provider fields (`PROVIDER_FIELDS`); blank secret fields keep the stored value. */
  settings: Record<string, string>;
  /** Recipient for the test message sent before enabling an untested configuration. */
  testTo?: string;
}

export interface PlatformStorageDto extends IntegrationTestStatus {
  driver: StorageDriverKey;
  /** The configured driver is in use (activation requires a passing connection test). */
  active: boolean;
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  accessKeyId: string | null;
  hasSecret: boolean;
  secretHint: string | null;
  /** Driver currently serving files. */
  effectiveDriver: string;
  /** Driver selected by the server environment (`STORAGE_DRIVER`). */
  envDriver: string;
  updatedAt: string | null;
}

export interface PlatformStorageInput {
  driver: StorageDriverKey;
  active: boolean;
  bucket?: string | null;
  region?: string | null;
  endpoint?: string | null;
  accessKeyId?: string | null;
  /** Blank/omitted keeps the stored secret. */
  secretAccessKey?: string;
}

/** `GET /admin/platform/integrations`. */
export interface PlatformIntegrationsDto {
  gateways: PlatformGatewayDto[];
  messaging: PlatformMessagingDto[];
  storage: PlatformStorageDto;
}

export interface IntegrationTestResultDto {
  ok: boolean;
  message: string;
  testedAt: string;
}

// ------------------------------------------------------------------ data export and deletion

export type DataExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';

export interface DataExportDto {
  id: number;
  status: DataExportStatus;
  includeMedia: boolean;
  requestedBy: number | null;
  requestedByName: string | null;
  sizeBytes: number | null;
  tableCount: number | null;
  rowCount: number | null;
  fileCount: number | null;
  error: string | null;
  completedAt: string | null;
  /** The archive is deleted after this time. */
  expiresAt: string | null;
  createdAt: string;
}

export type DeletionRequestStatus =
  'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed' | 'failed';

export interface DeletionRequestDto {
  id: number;
  instituteId: number | null;
  instituteName: string;
  instituteSlug: string;
  status: DeletionRequestStatus;
  reason: string | null;
  requestedBy: number | null;
  requestedByName: string | null;
  decidedBy: number | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Permanent deletion runs after this time (approval + grace period). */
  scheduledFor: string | null;
  completedAt: string | null;
  /** Rows deleted per table and files removed. */
  summary: { tables: Record<string, number>; files: number; users: number } | null;
  error: string | null;
  createdAt: string;
}
