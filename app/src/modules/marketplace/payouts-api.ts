import type {
  MktOrderRefundsDto,
  MktPage,
  MktPayoutAccountDto,
  MktPayoutAccountInput,
  MktPayoutAdminDto,
  MktPayoutDetailDto,
  MktPayoutDto,
  MktPayoutPreviewDto,
  MktPayoutRunDetailDto,
  MktPayoutRunDto,
  MktPayoutSettingsDto,
  MktPayoutStatus,
  MktRefundDto,
  MktRefundStatus,
  MktRevenueDto,
  MktRevenueGroup,
} from '@erp/shared';
import { api } from '@/core/api';
import { saveFile } from '@/core/downloads';
import type { StudioScope } from './api';

export const PAYOUT_STATUS_COLORS: Record<MktPayoutStatus, string> = {
  pending: 'warning',
  held: 'danger',
  paid: 'success',
  cancelled: 'medium',
};

export const REFUND_STATUS_COLORS: Record<MktRefundStatus, string> = {
  requested: 'warning',
  rejected: 'medium',
  refunded: 'success',
  failed: 'danger',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Chart label for a revenue period: `2026-11` → `Nov 26`, `2026-11-05` → `5 Nov`. */
export function periodShort(period: string): string {
  const [y, m, d] = period.split('-');
  const month = MONTHS[Number(m) - 1] ?? m;
  return d ? `${Number(d)} ${month}` : `${month} ${y.slice(2)}`;
}

/** A payout's period, e.g. `1 Oct – 31 Oct 2026` (end is exclusive, IST). */
export function payoutPeriod(start: string, end: string): string {
  const fmt = (d: Date, year: boolean) =>
    d.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      ...(year ? { year: 'numeric' } : {}),
      timeZone: 'Asia/Kolkata',
    });
  const last = new Date(new Date(end).getTime() - 1);
  return `${fmt(new Date(start), false)} – ${fmt(last, true)}`;
}

export const dateLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** Paise as a signed rupee amount: refunds show as `−₹499.00`. */
export const signedRupees = (paise: number) =>
  `${paise < 0 ? '−' : ''}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

async function downloadCsv(path: string, fallback: string) {
  const file = await api.download(path);
  return saveFile(file.blob, file.fileName ?? fallback);
}

/** The seller's revenue, payout details and statements. */
export function payoutStudioApi(scope: StudioScope) {
  const base = `/marketplace/${scope}`;
  return {
    revenue: (q: { from?: string; to?: string; groupBy?: MktRevenueGroup } = {}) =>
      api.get<MktRevenueDto>(`${base}/revenue`, q),
    account: () => api.get<{ account: MktPayoutAccountDto | null }>(`${base}/payout-account`),
    saveAccount: (input: MktPayoutAccountInput) =>
      api.put<MktPayoutAccountDto>(`${base}/payout-account`, input),
    payouts: () => api.get<MktPayoutDto[]>(`${base}/payouts`),
    payout: (id: number) => api.get<MktPayoutDetailDto>(`${base}/payouts/${id}`),
    statement: (id: number) => downloadCsv(`${base}/payouts/${id}/statement.csv`, `payout-${id}.csv`),
  };
}

const admin = '/admin/marketplace';

/** Platform admin: payout runs, refunds and payout settings. */
export const payoutAdminApi = {
  settings: () => api.get<MktPayoutSettingsDto>(`${admin}/payout-settings`),
  saveSettings: (input: Partial<MktPayoutSettingsDto>) =>
    api.put<MktPayoutSettingsDto>(`${admin}/payout-settings`, input),
  preview: (periodEnd?: string) =>
    api.get<MktPayoutPreviewDto>(`${admin}/payout-preview`, periodEnd ? { periodEnd } : undefined),
  runs: () => api.get<MktPayoutRunDto[]>(`${admin}/payout-runs`),
  createRun: (periodEnd?: string) =>
    api.post<MktPayoutRunDetailDto>(`${admin}/payout-runs`, periodEnd ? { periodEnd } : {}),
  run: (id: number) => api.get<MktPayoutRunDetailDto>(`${admin}/payout-runs/${id}`),
  exportRun: (id: number) => downloadCsv(`${admin}/payout-runs/${id}/export.csv`, `payout-run-${id}.csv`),
  finalizeRun: (id: number) => api.post<MktPayoutRunDetailDto>(`${admin}/payout-runs/${id}/finalize`),
  cancelRun: (id: number) => api.post<MktPayoutRunDetailDto>(`${admin}/payout-runs/${id}/cancel`),
  reveal: (id: number) =>
    api.get<MktPayoutAccountDto & { accountNumber?: string; upiId?: string }>(
      `${admin}/payouts/${id}/account`,
    ),
  markPaid: (id: number, input: { reference: string; paidAt?: string | null }) =>
    api.post<MktPayoutAdminDto>(`${admin}/payouts/${id}/paid`, input),
  hold: (id: number, reason: string) =>
    api.post<MktPayoutAdminDto>(`${admin}/payouts/${id}/hold`, { reason }),
  release: (id: number) => api.post<MktPayoutAdminDto>(`${admin}/payouts/${id}/release`),
  cancel: (id: number, reason?: string) =>
    api.post<MktPayoutAdminDto>(`${admin}/payouts/${id}/cancel`, { reason: reason || null }),
  refunds: (q: { status?: MktRefundStatus; page?: number } = {}) =>
    api.get<MktPage<MktRefundDto>>(`${admin}/refunds`, q),
  approveRefund: (id: number, note?: string) =>
    api.post<MktRefundDto>(`${admin}/refunds/${id}/approve`, { note: note || null }),
  rejectRefund: (id: number, note: string) =>
    api.post<MktRefundDto>(`${admin}/refunds/${id}/reject`, { note }),
  refundOrder: (orderId: number, input: { courseId?: number | null; reason: string }) =>
    api.post<MktRefundDto>(`${admin}/orders/${orderId}/refund`, input),
};

/** The learner's refund requests for an order. */
export const refundApi = {
  forOrder: (orderId: number) => api.get<MktOrderRefundsDto>(`/marketplace/orders/${orderId}/refunds`),
  request: (orderId: number, input: { courseId?: number | null; reason: string }) =>
    api.post<MktRefundDto>(`/marketplace/orders/${orderId}/refunds`, input),
};
