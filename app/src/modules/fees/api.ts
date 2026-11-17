import type {
  BankAccountDto,
  BankStatementLineDto,
  CheckoutOrderDto,
  CourseQuoteDto,
  FeeAccountDto,
  FeeAdjustmentDto,
  FeeHeadDto,
  FeePaymentDto,
  FeeReceiptDto,
  FeeSettings,
  FeeStructureDto,
  FinanceCategoryDto,
  FinanceEntryDto,
  GatewayConfigDto,
  LedgerEntryDto,
  MyFeesDto,
  PaymentGatewayKey,
  ProfitLossDto,
} from '@erp/shared';
import { API_URL, ApiError, api } from '@/core/api';
import { loadSession } from '@/core/token-storage';
import type { Page } from '../hr/api';

export interface SignedUrl {
  url: string;
  expiresAt: string;
}
export interface ConcessionRule {
  id: number;
  name: string;
  type: 'concession' | 'scholarship' | 'discount';
  mode: 'fixed' | 'percent';
  value: number;
  requiresApproval: boolean;
  active: boolean;
  description: string | null;
}
export interface FeeSummary {
  todayCollection: number;
  monthCollection: number;
  outstanding: number;
  overdue: number;
  defaulters: number;
  pendingPaymentApprovals: number;
  pendingAdjustments: number;
}
export type AccountDetail = FeeAccountDto & { payments: FeePaymentDto[] };
export type Query = Record<string, string | number | boolean | undefined>;
export interface WebhookResult {
  outcome: string;
  payment: FeePaymentDto;
}

const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });

export const feesApi = {
  summary: () => api.get<FeeSummary>('/fees/reports/summary'),
  settings: () => api.get<FeeSettings>('/fees/settings'),
  saveSettings: (b: Partial<FeeSettings>) => api.put<FeeSettings>('/fees/settings', b),
  heads: () => api.get<FeeHeadDto[]>('/fees/heads'),
  createHead: (b: Partial<FeeHeadDto>) => api.post<FeeHeadDto>('/fees/heads', b),
  updateHead: (id: number, b: Partial<FeeHeadDto>) => api.patch<FeeHeadDto>(`/fees/heads/${id}`, b),
  runSweep: () => api.post<{ reminders: number; overdue: number; lateFees: number }>('/fees/jobs/sweep', {}),
  rules: () => api.get<ConcessionRule[]>('/fees/rules'),
  saveRule: (b: Partial<ConcessionRule>, id?: number) =>
    id ? api.patch<ConcessionRule>(`/fees/rules/${id}`, b) : api.post<ConcessionRule>('/fees/rules', b),
  gateways: () => api.get<GatewayConfigDto[]>('/fees/gateways'),
  saveGateway: (g: PaymentGatewayKey, b: Record<string, unknown>) =>
    api.put<GatewayConfigDto>(`/fees/gateways/${g}`, b),

  structures: (q: Query = {}) => api.get<Page<FeeStructureDto>>('/fees/structures', { pageSize: 100, ...q }),
  structure: (id: number) =>
    api.get<FeeStructureDto & { versions: FeeStructureDto[] }>(`/fees/structures/${id}`),
  createStructure: (b: unknown) => api.post<FeeStructureDto>('/fees/structures', b),
  newVersion: (id: number, b: unknown) => api.post<FeeStructureDto>(`/fees/structures/${id}/versions`, b),
  updateStructure: (id: number, b: unknown) => api.patch<FeeStructureDto>(`/fees/structures/${id}`, b),

  accounts: (q: Query = {}) => api.get<Page<FeeAccountDto>>('/fees/accounts', { pageSize: 50, ...q }),
  account: (id: number) => api.get<AccountDetail>(`/fees/accounts/${id}`),
  ledger: (id: number) => api.get<LedgerEntryDto[]>(`/fees/accounts/${id}/ledger`),
  createAccount: (b: { studentId: number; structureId: number; firstDueDate?: string }) =>
    api.post<FeeAccountDto>('/fees/accounts', b),
  generateBatch: (b: { batchId: number; structureId?: number; firstDueDate?: string }) =>
    api.post<{ created: number; skipped: number; structureId: number }>('/fees/accounts/generate-batch', b),
  cancelAccount: (id: number, reason?: string) => api.post(`/fees/accounts/${id}/cancel`, { reason }),
  requestAdjustment: (id: number, b: unknown) =>
    api.post<FeeAdjustmentDto>(`/fees/accounts/${id}/adjustments`, b),
  adjustments: (status?: string) =>
    api.get<Page<FeeAdjustmentDto>>('/fees/adjustments', { status, pageSize: 100 }),
  decideAdjustment: (id: number, approve: boolean) =>
    api.post<FeeAdjustmentDto>(`/fees/adjustments/${id}/${approve ? 'approve' : 'reject'}`),

  payments: (q: Query = {}) => api.get<Page<FeePaymentDto>>('/fees/payments', { pageSize: 50, ...q }),
  recordOffline: (b: unknown) => api.post<FeePaymentDto>('/fees/payments/offline', b, { headers: idem() }),
  decidePayment: (id: number, approve: boolean, reason?: string) =>
    api.post<FeePaymentDto>(`/fees/payments/${id}/${approve ? 'approve' : 'reject'}`, { reason }),
  checkout: (b: { accountId: number; amount?: number; gateway?: PaymentGatewayKey }) =>
    api.post<CheckoutOrderDto>('/fees/payments/checkout', b, { headers: idem() }),
  mockComplete: (id: number, outcome: 'success' | 'failed') =>
    api.post<WebhookResult>(`/fees/payments/${id}/mock-complete`, { outcome }),
  sync: (id: number) => api.post<WebhookResult>(`/fees/payments/${id}/sync`),
  refund: (id: number, b: { amount?: number; reason?: string; reduceDues?: boolean }) =>
    api.post<{ payment: FeePaymentDto }>(`/fees/payments/${id}/refund`, b, { headers: idem() }),
  cancelPayment: (id: number, reason?: string) =>
    api.post<FeePaymentDto>(`/fees/payments/${id}/cancel`, { reason }),
  receipt: (id: number) => api.get<FeeReceiptDto>(`/fees/receipts/${id}`),
  receiptPdf: (id: number) => api.get<SignedUrl>(`/fees/receipts/${id}/pdf`),
  shareReceipt: (id: number) => api.post<{ shared: boolean }>(`/fees/receipts/${id}/share`),

  // accounting
  bankAccounts: () => api.get<BankAccountDto[]>('/fees/bank-accounts'),
  saveBankAccount: (b: Partial<BankAccountDto>, id?: number) =>
    id
      ? api.patch<BankAccountDto>(`/fees/bank-accounts/${id}`, b)
      : api.post<BankAccountDto>('/fees/bank-accounts', b),
  statement: (id: number, status?: string) =>
    api.get<BankStatementLineDto[]>(`/fees/bank-accounts/${id}/statement`, { status }),
  importStatement: (id: number, csv: string) =>
    api.post<BankStatementLineDto[]>(`/fees/bank-accounts/${id}/statement`, { csv }),
  suggestions: (lineId: number) =>
    api.get<{
      payments: { id: number; date: string; amount: number; student?: string; reference: string | null }[];
      entries: FinanceEntryDto[];
    }>(`/fees/statement-lines/${lineId}/suggestions`),
  reconcile: (lineId: number, b: { action: 'match' | 'ignore' | 'unmatch'; type?: string; id?: number }) =>
    api.post<BankStatementLineDto>(`/fees/statement-lines/${lineId}/reconcile`, b),
  categories: () => api.get<FinanceCategoryDto[]>('/fees/finance/categories'),
  createCategory: (b: { kind: string; name: string }) =>
    api.post<FinanceCategoryDto>('/fees/finance/categories', b),
  entries: (q: Query = {}) =>
    api.get<Page<FinanceEntryDto>>('/fees/finance/entries', { pageSize: 100, ...q }),
  createEntry: (b: unknown) => api.post<FinanceEntryDto>('/fees/finance/entries', b),
  cancelEntry: (id: number) => api.post<FinanceEntryDto>(`/fees/finance/entries/${id}/cancel`),
  pnl: (from: string, to: string) => api.get<ProfitLossDto>('/fees/reports/pnl', { from, to }),
  report: <T>(kind: string, q: Query) => api.get<T>(`/fees/reports/${kind}`, q),
  trialBalance: () =>
    api.get<{
      rows: { account: string; debit: number; credit: number; balance: number }[];
      balanced: boolean;
    }>('/fees/ledger/trial-balance'),

  // student / parent
  my: (studentId?: number) => api.get<MyFeesDto>('/fees/me', { studentId }),
  myCheckout: (b: { accountId: number; amount?: number; gateway?: PaymentGatewayKey }) =>
    api.post<CheckoutOrderDto>('/fees/me/checkout', b, { headers: idem() }),
  myMockComplete: (id: number, outcome: 'success' | 'failed') =>
    api.post<WebhookResult>(`/fees/me/payments/${id}/mock-complete`, { outcome }),
  courseQuote: (courseId: number, q: { batchId?: number; coupon?: string }) =>
    api.get<CourseQuoteDto>(`/fees/me/courses/${courseId}/quote`, q),
  courseCheckout: (
    courseId: number,
    b: { batchId?: number; couponCode?: string; referralCode?: string; gateway?: PaymentGatewayKey },
  ) => api.post<CheckoutOrderDto>(`/fees/me/courses/${courseId}/checkout`, b, { headers: idem() }),
  mySync: (id: number) => api.post<WebhookResult>(`/fees/me/payments/${id}/sync`),
  myReceiptPdf: (id: number) => api.get<SignedUrl>(`/fees/me/receipts/${id}/pdf`),
  myShareReceipt: (id: number) => api.post<{ shared: boolean }>(`/fees/me/receipts/${id}/share`),
};

/** Downloads a CSV/Excel report with the session's auth headers. */
export async function downloadFeesReport(path: string, query: Query, format: 'csv' | 'xls') {
  const session = await loadSession();
  const url = new URL(`${API_URL}/api/fees/${path}`);
  const params: Query = { ...query, format };
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  if (session?.branchId) headers['X-Branch-Id'] = String(session.branchId);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new ApiError(res.status, 'HTTP_ERROR', `Export failed (${res.status})`);
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `report.${format}`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await res.blob());
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export const openSigned = (s: SignedUrl) => window.open(s.url, '_blank');
export const toPaise = (rupees: number | string) => Math.round(Number(rupees) * 100);
export const MODE_LABELS: Record<string, string> = {
  online: 'Online',
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
};
export const STATUS_COLORS: Record<string, string> = {
  successful: 'success',
  paid: 'success',
  approved: 'success',
  active: 'success',
  pending: 'warning',
  partial: 'warning',
  failed: 'danger',
  rejected: 'danger',
  cancelled: 'medium',
  refunded: 'medium',
  partially_refunded: 'tertiary',
  archived: 'medium',
  draft: 'medium',
};
