import type {
  AddonKind,
  AdminSubscriptionRowDto,
  BillingActionResultDto,
  BillingCycle,
  BillingOverviewDto,
  BillingPolicyDto,
  BillingProfileDto,
  CheckoutReturnInput,
  Paginated,
  PlanChangePreviewDto,
  SaasCheckoutDto,
  SaasCreditNoteDto,
  SaasInvoiceDetailDto,
  SaasInvoiceDto,
  SaasInvoiceKind,
  SaasInvoiceStatus,
  SaasPaymentDto,
  SaasPaymentMethod,
  SaasPaymentStatus,
  SubscriptionAccessState,
  SubscriptionAddonDto,
  SubscriptionDto,
  SubscriptionStatusDto,
  UsageSnapshotDto,
} from '@erp/shared';
import { api } from '@/core/api';

export interface SignedLink {
  url: string;
  expiresAt: string;
}
export const openLink = (s: SignedLink) => window.open(s.url, '_blank');

export interface PageQuery {
  page?: number;
  pageSize?: number;
}
export interface InvoiceQuery extends PageQuery {
  status?: SaasInvoiceStatus;
  kind?: SaasInvoiceKind;
  instituteId?: number;
  /** Matches part of the invoice number. */
  search?: string;
}
export interface PaymentQuery extends PageQuery {
  instituteId?: number;
  invoiceId?: number;
  status?: SaasPaymentStatus;
  method?: SaasPaymentMethod;
  from?: string;
  to?: string;
}
export type InvoiceFilters = Pick<InvoiceQuery, 'status' | 'kind' | 'search'>;
export type PaymentFilters = Pick<PaymentQuery, 'status' | 'method' | 'from' | 'to'>;

/** Super admin plan assignment; `endsAt` null = open-ended (platform-managed, no self-service). */
export interface AssignPlanInput {
  planId: number;
  status: 'trial' | 'active';
  billingCycle: BillingCycle;
  endsAt: string | null;
}

export interface PaymentResult {
  outcome: string;
  payment: SaasPaymentDto;
}
export interface ManualInvoiceInput {
  instituteId: number;
  lines: { description: string; quantity: number; unitPricePaise: number }[];
  dueDate?: string;
  notes?: string | null;
}
export interface ManualPaymentInput {
  amountPaise: number;
  reference?: string | null;
  note?: string | null;
  paidAt?: string | null;
}

/** Institute side (`subscription.view` / `subscription.edit`). */
export const billingApi = {
  status: () => api.get<SubscriptionStatusDto>('/subscription/status'),
  overview: () => api.get<BillingOverviewDto>('/subscription/overview'),
  snapshots: (q: { from?: string; to?: string } = {}) =>
    api.get<UsageSnapshotDto[]>('/subscription/usage/snapshots', q),
  invoices: (q: Omit<InvoiceQuery, 'instituteId'> = {}) =>
    api.get<Paginated<SaasInvoiceDto>>('/subscription/invoices', { ...q }),
  invoice: (id: number) => api.get<SaasInvoiceDetailDto>(`/subscription/invoices/${id}`),
  invoicePdf: (id: number) => api.get<SignedLink>(`/subscription/invoices/${id}/pdf`),
  creditNotes: (q: PageQuery = {}) =>
    api.get<Paginated<SaasCreditNoteDto>>('/subscription/credit-notes', { ...q }),
  creditNotePdf: (id: number) => api.get<SignedLink>(`/subscription/credit-notes/${id}/pdf`),
  payments: (q: Omit<PaymentQuery, 'instituteId'> = {}) =>
    api.get<Paginated<SaasPaymentDto>>('/subscription/payments', { ...q }),
  /** Retries with the same key resume the same gateway order instead of starting another. */
  checkout: (invoiceId: number, idempotencyKey: string, returnTo?: CheckoutReturnInput) =>
    api.post<SaasCheckoutDto>(
      `/subscription/invoices/${invoiceId}/checkout`,
      { returnTo },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    ),
  mockComplete: (paymentId: number, outcome: 'success' | 'failed') =>
    api.post<PaymentResult>(`/subscription/payments/${paymentId}/mock-complete`, { outcome }),
  sync: (paymentId: number) => api.post<PaymentResult>(`/subscription/payments/${paymentId}/sync`),
  renew: () => api.post<BillingActionResultDto>('/subscription/renew'),
  previewPlanChange: (planId: number, billingCycle: BillingCycle) =>
    api.post<PlanChangePreviewDto>('/subscription/plan-change/preview', { planId, billingCycle }),
  changePlan: (planId: number, billingCycle: BillingCycle) =>
    api.post<BillingActionResultDto>('/subscription/plan-change', { planId, billingCycle }),
  cancelPlanChange: () => api.delete('/subscription/plan-change'),
  buyAddon: (b: { kind: AddonKind; moduleKey?: string | null; quantity: number }) =>
    api.post<BillingActionResultDto>('/subscription/addons', b),
  cancelAddon: (id: number) => api.post<SubscriptionAddonDto>(`/subscription/addons/${id}/cancel`),
};

/** Super admin (`/admin/billing`). */
export const billingAdminApi = {
  subscriptions: (
    q: PageQuery & { state?: SubscriptionAccessState; planId?: number; search?: string } = {},
  ) => api.get<Paginated<AdminSubscriptionRowDto>>('/admin/billing/subscriptions', { ...q }),
  overview: (instituteId: number) =>
    api.get<BillingOverviewDto>(`/admin/billing/institutes/${instituteId}/overview`),
  snapshots: (instituteId: number, q: { from?: string; to?: string } = {}) =>
    api.get<UsageSnapshotDto[]>(`/admin/billing/institutes/${instituteId}/usage-snapshots`, q),
  extendTrial: (instituteId: number, days: number) =>
    api.post<SubscriptionDto>(`/admin/billing/institutes/${instituteId}/extend-trial`, { days }),
  suspend: (instituteId: number, reason: string) =>
    api.post<SubscriptionDto>(`/admin/billing/institutes/${instituteId}/suspend`, { reason }),
  reactivate: (instituteId: number, extendDays: number | null) =>
    api.post<SubscriptionDto>(`/admin/billing/institutes/${instituteId}/reactivate`, { extendDays }),
  assignPlan: (instituteId: number, b: AssignPlanInput) =>
    api.post<SubscriptionDto>(`/admin/institutes/${instituteId}/subscriptions`, b),
  renewalInvoice: (instituteId: number) =>
    api.post<BillingActionResultDto>(`/admin/billing/institutes/${instituteId}/renewal-invoice`),
  invoices: (q: InvoiceQuery = {}) => api.get<Paginated<SaasInvoiceDto>>('/admin/billing/invoices', { ...q }),
  invoice: (id: number) => api.get<SaasInvoiceDetailDto>(`/admin/billing/invoices/${id}`),
  invoicePdf: (id: number) => api.get<SignedLink>(`/admin/billing/invoices/${id}/pdf`),
  createInvoice: (b: ManualInvoiceInput) => api.post<SaasInvoiceDto>('/admin/billing/invoices', b),
  voidInvoice: (id: number, reason: string) =>
    api.post<SaasInvoiceDto>(`/admin/billing/invoices/${id}/void`, { reason }),
  recordPayment: (id: number, b: ManualPaymentInput) =>
    api.post<{ payment: SaasPaymentDto; invoice: SaasInvoiceDto }>(
      `/admin/billing/invoices/${id}/payments`,
      b,
    ),
  creditNote: (id: number, amountPaise: number, reason: string) =>
    api.post<{ creditNote: SaasCreditNoteDto; invoice: SaasInvoiceDto }>(
      `/admin/billing/invoices/${id}/credit-notes`,
      { amountPaise, reason },
    ),
  creditNotes: (q: PageQuery & { instituteId?: number } = {}) =>
    api.get<Paginated<SaasCreditNoteDto>>('/admin/billing/credit-notes', { ...q }),
  creditNotePdf: (id: number) => api.get<SignedLink>(`/admin/billing/credit-notes/${id}/pdf`),
  payments: (q: PaymentQuery = {}) => api.get<Paginated<SaasPaymentDto>>('/admin/billing/payments', { ...q }),
  syncPayment: (id: number) => api.post<PaymentResult>(`/admin/billing/payments/${id}/sync`),
  settings: () =>
    api.get<{ profile: BillingProfileDto; policy: BillingPolicyDto }>('/admin/billing/settings'),
  saveProfile: (b: BillingProfileDto) => api.put<BillingProfileDto>('/admin/billing/settings/profile', b),
  savePolicy: (b: BillingPolicyDto) => api.put<BillingPolicyDto>('/admin/billing/settings/policy', b),
};

/** Invoice operations shared by the institute and super admin screens. */
export interface InvoiceSource {
  detail: (id: number) => Promise<SaasInvoiceDetailDto>;
  invoicePdf: (id: number) => Promise<SignedLink>;
  creditNotePdf: (id: number) => Promise<SignedLink>;
  /** Asks the gateway for the latest status of a pending payment. */
  syncPayment: (paymentId: number) => Promise<PaymentResult>;
}
export const tenantInvoices: InvoiceSource = {
  detail: billingApi.invoice,
  invoicePdf: billingApi.invoicePdf,
  creditNotePdf: billingApi.creditNotePdf,
  syncPayment: billingApi.sync,
};
export const adminInvoices: InvoiceSource = {
  detail: billingAdminApi.invoice,
  invoicePdf: billingAdminApi.invoicePdf,
  creditNotePdf: billingAdminApi.creditNotePdf,
  syncPayment: billingAdminApi.syncPayment,
};
