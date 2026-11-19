/**
 * Fees, payments & accounting DTOs (spec §4.5, §8 Paytm, §9 financial integrity).
 * All money values are integer paise.
 */

export const FEE_PAYMENT_MODES = ['online', 'cash', 'upi', 'bank_transfer', 'cheque'] as const;
export type FeePaymentMode = (typeof FEE_PAYMENT_MODES)[number];
export const OFFLINE_PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque'] as const;
export type OfflinePaymentMode = (typeof OFFLINE_PAYMENT_MODES)[number];

export const FEE_PAYMENT_STATUSES = [
  'pending',
  'failed',
  'successful',
  'partially_refunded',
  'refunded',
  'cancelled',
] as const;
export type FeePaymentStatus = (typeof FEE_PAYMENT_STATUSES)[number];
export type FeeApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export const PAYMENT_GATEWAYS = ['mock', 'paytm', 'razorpay', 'cashfree'] as const;
export type PaymentGatewayKey = (typeof PAYMENT_GATEWAYS)[number];

/** Where a checkout runs: the vendor's hosted pages send the payer back to the matching app origin. */
export const CHECKOUT_PLATFORMS = ['web', 'android', 'ios'] as const;
export type CheckoutPlatform = (typeof CHECKOUT_PLATFORMS)[number];

/** App route the payer returns to after a redirect-based checkout (`path` like `/my-fees`). */
export interface CheckoutReturnInput {
  platform: CheckoutPlatform;
  path?: string;
}

export const INSTALMENT_PLAN_TYPES = ['one_time', 'monthly', 'quarterly', 'custom'] as const;
export type InstalmentPlanType = (typeof INSTALMENT_PLAN_TYPES)[number];

export type FeeStructureKind = 'course' | 'subject';
export type FeeStructureStatus = 'draft' | 'active' | 'archived';
export type FeeAccountStatus = 'active' | 'closed' | 'cancelled';
export type FeeInstalmentStatus = 'pending' | 'partial' | 'paid' | 'waived';
export const FEE_ADJUSTMENT_TYPES = ['discount', 'concession', 'scholarship', 'charge', 'waiver'] as const;
export type FeeAdjustmentType = (typeof FEE_ADJUSTMENT_TYPES)[number];
export type FeeAdjustmentStatus = 'pending' | 'approved' | 'rejected';
export type AmountMode = 'fixed' | 'percent';
export type LateFeeType = 'none' | 'fixed' | 'percent' | 'per_day';

export interface FeeComponentLine {
  feeHeadId: number | null;
  name: string;
  amount: number;
  taxable: boolean;
}

export interface CustomInstalment {
  label: string;
  dueDate: string;
  /** Share of the total in percent (0–100); the last instalment absorbs rounding. */
  percent: number;
}

export interface InstalmentPlan {
  type: InstalmentPlanType;
  /** Number of instalments for monthly/quarterly. */
  count?: number;
  /** First due date (YYYY-MM-DD) for monthly/quarterly/one_time. */
  firstDueDate?: string;
  custom?: CustomInstalment[];
}

export interface FeeSettings {
  /** Tokens: {INST} {BRANCH} {FY} (e.g. 2026-27) {YYYY} {YY} {MM} {SEQ} / {SEQ:5}. */
  receiptFormat: string;
  invoiceFormat: string;
  gstEnabled: boolean;
  gstin: string | null;
  gstRatePercent: number;
  /** Fee amounts already include GST. */
  gstInclusive: boolean;
  /** Inter-state supply → IGST instead of CGST + SGST. */
  gstInterState: boolean;
  sacCode: string;
  lateFee: {
    type: LateFeeType;
    amount: number;
    percent: number;
    graceDays: number;
    maxAmount: number | null;
  };
  /** Days before the due date to send `fees.due`. */
  reminderDaysBefore: number;
  offlineApprovalRequired: boolean;
  /** Discounts/concessions above this amount (paise) need approval; 0 = always. */
  concessionApprovalThreshold: number;
  /** Instalment number that must be fully paid to unlock course access (default 1). */
  entitlementAfterInstalment: number;
}

export interface FeeHeadDto {
  id: number;
  name: string;
  code: string;
  taxable: boolean;
  active: boolean;
}

export interface FeeStructureDto {
  id: number;
  branchId: number | null;
  kind: FeeStructureKind;
  courseId: number | null;
  batchId: number | null;
  subjectId: number | null;
  academicSessionId: number | null;
  name: string;
  version: number;
  familyId: number;
  status: FeeStructureStatus;
  effectiveFrom: string;
  components: FeeComponentLine[];
  total: number;
  instalmentPlan: InstalmentPlan;
  createdAt: string;
}

export interface FeeInstalmentDto {
  id: number;
  seq: number;
  label: string;
  dueDate: string;
  amount: number;
  lateFee: number;
  paid: number;
  balance: number;
  status: FeeInstalmentStatus;
  overdue: boolean;
}

export interface FeeAdjustmentDto {
  id: number;
  accountId: number;
  type: FeeAdjustmentType;
  mode: AmountMode;
  value: number;
  amount: number;
  reason: string | null;
  ruleId: number | null;
  status: FeeAdjustmentStatus;
  requestedByUserId: number | null;
  decidedByUserId: number | null;
  createdAt: string;
}

export interface FeeAccountDto {
  id: number;
  branchId: number;
  studentId: number;
  studentName?: string;
  admissionNumber?: string;
  title: string;
  structureId: number | null;
  courseId: number | null;
  batchId: number | null;
  subjectId: number | null;
  gross: number;
  discount: number;
  charges: number;
  lateFee: number;
  net: number;
  paid: number;
  advance: number;
  balance: number;
  status: FeeAccountStatus;
  source: string;
  instalments?: FeeInstalmentDto[];
  adjustments?: FeeAdjustmentDto[];
  createdAt: string;
}

export interface FeePaymentDto {
  id: number;
  branchId: number;
  accountId: number;
  studentId: number;
  studentName?: string;
  amount: number;
  mode: FeePaymentMode;
  gateway: PaymentGatewayKey | null;
  status: FeePaymentStatus;
  approvalStatus: FeeApprovalStatus;
  referenceNo: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  bankName: string | null;
  paidOn: string | null;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  gatewayCharge: number;
  refunded: number;
  receiptId: number | null;
  receiptNumber: string | null;
  bankAccountId: number | null;
  notes: string | null;
  /** Website coupon applied to an online order and its discount (paise). */
  couponCode?: string | null;
  couponDiscount?: number;
  referralCode?: string | null;
  createdAt: string;
}

export interface FeeReceiptDto {
  id: number;
  number: string;
  invoiceNumber: string | null;
  paymentId: number;
  accountId: number;
  studentId: number;
  amount: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  status: 'issued' | 'cancelled';
  issuedAt: string;
}

export interface CheckoutOrderDto {
  paymentId: number;
  gateway: PaymentGatewayKey;
  gatewayOrderId: string;
  /** Amount charged (after any coupon discount), in paise. */
  amount: number;
  discount?: number;
  couponCode?: string | null;
  checkout: Record<string, unknown>;
}

/** Why an online course purchase could not use a batch (the one chosen at checkout, or any). */
export const COURSE_BATCH_ISSUES = [
  'not_found',
  'other_course',
  'other_branch',
  'closed',
  'full',
  'no_login',
  'no_open_batch',
] as const;
export type CourseBatchIssue = (typeof COURSE_BATCH_ISSUES)[number];

/** Reasons shown to admins and buyers. */
export const COURSE_BATCH_ISSUE_LABELS: Record<CourseBatchIssue, string> = {
  not_found: 'the batch chosen at checkout no longer exists',
  other_course: 'the batch chosen at checkout is for another course',
  other_branch: "the batch chosen at checkout is in another branch from the student's",
  closed: 'the batch chosen at checkout is closed',
  full: 'the batch chosen at checkout is full',
  no_login: 'the student has no login of their own yet',
  no_open_batch: 'no open batch of the course has free seats',
};

/** An open batch of a course with free seats, offered at checkout. */
export interface CourseBatchOptionDto {
  id: number;
  name: string;
  startDate: string;
  seatsLeft: number;
}

/** Price of a course for the "buy course" checkout (paise). */
export interface CourseQuoteDto {
  courseId: number;
  courseName: string;
  accountId: number | null;
  amount: number;
  discount: number;
  payable: number;
  coupon: { code: string; valid: boolean; message: string } | null;
  alreadyPaid: boolean;
  /** The batch chosen at checkout and whether it still has a seat for the student (null: none chosen). */
  batch: { id: number; name: string | null; available: boolean; reason: CourseBatchIssue | null } | null;
  /** The purchase can no longer switch batch: it is part-paid, or priced for its batch. */
  batchFixed: boolean;
  /** Open batches of the course in the student's branch with free seats. */
  openBatches: CourseBatchOptionDto[];
  /** Once paid: the admission and batch enrolment the purchase produced (null before that). */
  enrolment: { status: FeeCourseEnrolmentStatus; batchId: number | null; batchName: string | null } | null;
}

export const FEE_COURSE_ENROLMENT_STATUSES = ['enrolled', 'awaiting_batch', 'revoked'] as const;
export type FeeCourseEnrolmentStatus = (typeof FEE_COURSE_ENROLMENT_STATUSES)[number];

/**
 * The admission and batch enrolment produced by an online course purchase. `awaiting_batch` rows
 * form the admin queue: the student is paid and admitted but no batch could take them.
 */
export interface CourseEnrolmentDto {
  id: number;
  accountId: number;
  branchId: number;
  studentId: number;
  studentName: string | null;
  admissionNumber: string | null;
  courseId: number;
  courseName: string | null;
  status: FeeCourseEnrolmentStatus;
  requestedBatchId: number | null;
  requestedBatchName: string | null;
  batchId: number | null;
  batchName: string | null;
  applicationId: number | null;
  /** Why the chosen batch was not used, or why no batch was found. */
  reason: CourseBatchIssue | null;
  enrolledAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface GatewayConfigDto {
  id: number;
  gateway: PaymentGatewayKey;
  enabled: boolean;
  isDefault: boolean;
  merchantId: string | null;
  keyHint: string | null;
  sandbox: boolean;
  /** Public URL the gateway must post webhooks to. */
  webhookUrl: string;
  /** Provisioned from the platform's global gateway (no own merchant account configured). */
  platformManaged?: boolean;
  /** A merchant secret / key secret / client secret is stored (never returned). */
  hasSecret: boolean;
  /** A separate webhook secret is stored (Razorpay). */
  hasWebhookSecret: boolean;
  /** Paytm website name (WEBSTAGING in staging, DEFAULT in production unless Paytm assigned another). */
  website: string | null;
}

export interface BankAccountDto {
  id: number;
  branchId: number | null;
  name: string;
  bankName: string | null;
  accountNumberLast4: string | null;
  ifsc: string | null;
  openingBalance: number;
  active: boolean;
  balance?: number;
}

export interface BankStatementLineDto {
  id: number;
  bankAccountId: number;
  txnDate: string;
  description: string | null;
  reference: string | null;
  amount: number;
  status: 'unmatched' | 'matched' | 'ignored';
  matchedType: 'payment' | 'finance_entry' | null;
  matchedId: number | null;
}

export type FinanceEntryKind = 'expense' | 'income';
export interface FinanceCategoryDto {
  id: number;
  kind: FinanceEntryKind;
  name: string;
  active: boolean;
}
export interface FinanceEntryDto {
  id: number;
  branchId: number | null;
  kind: FinanceEntryKind;
  categoryId: number;
  date: string;
  amount: number;
  tax: number;
  mode: OfflinePaymentMode;
  bankAccountId: number | null;
  party: string | null;
  reference: string | null;
  notes: string | null;
  attachmentFileId: number | null;
  status: 'recorded' | 'cancelled';
  createdAt: string;
}

export interface LedgerEntryDto {
  id: number;
  journalKey: string;
  line: number;
  date: string;
  account: string;
  debit: number;
  credit: number;
  feeAccountId: number | null;
  refType: string;
  refId: number | null;
  narration: string | null;
}

export interface ProfitLossDto {
  from: string;
  to: string;
  income: { label: string; amount: number }[];
  expenditure: { label: string; amount: number }[];
  totalIncome: number;
  totalExpenditure: number;
  net: number;
}

export interface MyFeesDto {
  student: { id: number; name: string; admissionNumber: string };
  /** All students the signed-in user may view (self and/or linked children). */
  students: { id: number; name: string; admissionNumber: string }[];
  accounts: FeeAccountDto[];
  payments: FeePaymentDto[];
  gateways: PaymentGatewayKey[];
  totalDue: number;
}

/** Ledger account codes. Bank accounts are `bank:<id>`, gateway clearing `gateway:<name>`. */
export const LEDGER_ACCOUNTS = {
  RECEIVABLE: 'student_receivable',
  ADVANCE: 'student_advance',
  FEE_INCOME: 'fee_income',
  LATE_FEE_INCOME: 'late_fee_income',
  DISCOUNTS: 'fee_discounts',
  GST_PAYABLE: 'gst_payable',
  CASH: 'cash',
  GATEWAY_CHARGES: 'gateway_charges',
  OTHER_INCOME: 'other_income',
  EXPENSES: 'expenses',
  UNDEPOSITED: 'undeposited_funds',
} as const;
