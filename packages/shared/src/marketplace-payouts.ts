import type { MktSellerRef } from './marketplace';

/**
 * Seller revenue, monthly payouts and refunds on the course marketplace. The platform collects
 * every payment; sellers are paid from the sale ledger by an admin payout run. Amounts in paise.
 */

export const MKT_PAYOUT_METHODS = ['bank', 'upi'] as const;
export type MktPayoutMethod = (typeof MKT_PAYOUT_METHODS)[number];

export const MKT_PAYOUT_RUN_STATUSES = ['draft', 'finalized', 'cancelled'] as const;
export type MktPayoutRunStatus = (typeof MKT_PAYOUT_RUN_STATUSES)[number];

/** `held`: not paid this run (no payout details, or held by the admin); rows stay reserved until released. */
export const MKT_PAYOUT_STATUSES = ['pending', 'held', 'paid', 'cancelled'] as const;
export type MktPayoutStatus = (typeof MKT_PAYOUT_STATUSES)[number];
export const MKT_PAYOUT_STATUS_LABELS: Record<MktPayoutStatus, string> = {
  pending: 'To pay',
  held: 'On hold',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

export const MKT_REFUND_STATUSES = ['requested', 'rejected', 'refunded', 'failed'] as const;
export type MktRefundStatus = (typeof MKT_REFUND_STATUSES)[number];
export const MKT_REFUND_STATUS_LABELS: Record<MktRefundStatus, string> = {
  requested: 'Requested',
  rejected: 'Rejected',
  refunded: 'Refunded',
  failed: 'Refund failed',
};

export const MKT_REVENUE_GROUPS = ['day', 'month'] as const;
export type MktRevenueGroup = (typeof MKT_REVENUE_GROUPS)[number];

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const UPI_ID_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

export interface MktPayoutSettingsDto {
  /** Sellers owed less than this are carried forward to a later run. */
  minPayoutPaise: number;
  /** Sales younger than this many days are not paid out yet (they can still be refunded). */
  holdDays: number;
  /** Learners may request a refund up to this many days after purchase. */
  refundWindowDays: number;
}

/** Payout details as shown back: account numbers are masked, never returned in full. */
export interface MktPayoutAccountDto {
  method: MktPayoutMethod;
  holderName: string;
  bankName: string | null;
  ifsc: string | null;
  /** e.g. `XXXXXX4321` or `ra••••@okaxis`. */
  maskedAccount: string;
  updatedAt: string;
}

export interface MktPayoutAccountInput {
  method: MktPayoutMethod;
  holderName: string;
  bankName?: string | null;
  accountNumber?: string | null;
  ifsc?: string | null;
  upiId?: string | null;
}

export interface MktRevenueTotals {
  /** What buyers paid (after coupons), net of refunds. */
  grossPaise: number;
  commissionPaise: number;
  /** Seller earnings after commission and refunds. */
  netPaise: number;
  /** Refunded to buyers (seller share reversed). */
  refundedPaise: number;
  sales: number;
  refunds: number;
}

export interface MktRevenuePoint extends MktRevenueTotals {
  /** `YYYY-MM-DD` or `YYYY-MM` (IST). */
  period: string;
}

export interface MktCourseRevenueDto {
  courseId: number;
  title: string;
  sales: number;
  refunds: number;
  enrolments: number;
  grossPaise: number;
  netPaise: number;
}

export interface MktSellerBalance {
  /** Earned, not in any payout yet (includes on-hold sales). */
  pendingPaise: number;
  /** Part of `pendingPaise` still inside the refund/hold window. */
  onHoldPaise: number;
  /** In a payout run, waiting to be paid. */
  processingPaise: number;
  paidPaise: number;
  lastPaidAt: string | null;
}

export interface MktRevenueDto {
  from: string;
  to: string;
  groupBy: MktRevenueGroup;
  totals: MktRevenueTotals;
  series: MktRevenuePoint[];
  courses: MktCourseRevenueDto[];
  balance: MktSellerBalance;
  settings: MktPayoutSettingsDto;
  hasPayoutAccount: boolean;
}

export interface MktPayoutDto {
  id: number;
  runId: number;
  seller: MktSellerRef;
  periodStart: string;
  periodEnd: string;
  status: MktPayoutStatus;
  /** Sales (gross paid by buyers) in this payout. */
  grossPaise: number;
  commissionPaise: number;
  /** Seller share of refunds deducted. */
  refundsPaise: number;
  /** Amount transferred to the seller. */
  netPaise: number;
  entries: number;
  /** Bank transfer UTR / UPI reference, once paid. */
  reference: string | null;
  /** Masked account the money was sent to (snapshot when paid). */
  paidTo: string | null;
  holdReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface MktPayoutLineDto {
  id: number;
  entryType: 'sale' | 'refund';
  orderNumber: string;
  courseTitle: string;
  grossPaise: number;
  commissionPercent: number;
  commissionPaise: number;
  /** Negative for refunds. */
  netPaise: number;
  createdAt: string;
}

export interface MktPayoutDetailDto extends MktPayoutDto {
  lines: MktPayoutLineDto[];
}

/** Admin view of one seller's payout inside a run: includes whether payout details exist. */
export interface MktPayoutAdminDto extends MktPayoutDto {
  account: MktPayoutAccountDto | null;
}

export interface MktPayoutRunDto {
  id: number;
  periodStart: string;
  periodEnd: string;
  status: MktPayoutRunStatus;
  payouts: number;
  paid: number;
  totalNetPaise: number;
  paidNetPaise: number;
  createdAt: string;
  finalizedAt: string | null;
}

export interface MktPayoutRunDetailDto extends MktPayoutRunDto {
  items: MktPayoutAdminDto[];
}

/** One seller in a payout preview (nothing is reserved yet). */
export interface MktPayoutPreviewRow {
  seller: MktSellerRef;
  grossPaise: number;
  commissionPaise: number;
  refundsPaise: number;
  netPaise: number;
  entries: number;
  hasAccount: boolean;
  /** Below the minimum (or not positive): carried forward, not included in a run. */
  carriedForward: boolean;
}

export interface MktPayoutPreviewDto {
  periodStart: string;
  periodEnd: string;
  /** Sales up to this time are old enough (hold window); refunds are always included. */
  eligibleBefore: string;
  settings: MktPayoutSettingsDto;
  rows: MktPayoutPreviewRow[];
  totalNetPaise: number;
}

export interface MktRefundDto {
  id: number;
  orderId: number;
  orderNumber: string;
  /** null = every paid course of the order. */
  courseId: number | null;
  courseTitle: string | null;
  buyer: { name: string; mobile: string | null };
  amountPaise: number;
  reason: string;
  status: MktRefundStatus;
  initiatedBy: 'learner' | 'admin';
  decisionNote: string | null;
  gatewayRefundId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** What the learner may still refund on an order. */
export interface MktOrderRefundsDto {
  /** Last day a refund may be requested, or null when the order is not refundable. */
  refundableUntil: string | null;
  refundableCourseIds: number[];
  requests: MktRefundDto[];
}
