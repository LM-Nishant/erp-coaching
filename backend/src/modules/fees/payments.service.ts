import crypto from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import type {
  CheckoutOrderDto,
  CheckoutReturnInput,
  FeePaymentDto,
  OfflinePaymentMode,
  PaymentGatewayKey,
} from '@erp/shared';
import { sha256 } from '../../infrastructure/crypto';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import {
  GatewayConfigError,
  GatewayRequestError,
  MockPaymentGateway,
  WebhookSignatureError,
  type GatewayOrder,
  type GatewayWebhookEvent,
  type PaymentGateway,
  type RefundResult,
  type VerifiedPayment,
} from '../../infrastructure/payment-gateways';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { AppError, BadRequest, Conflict, NotFound } from '../../shared/errors';
import { requireTenantContext, runWithContext } from '../../shared/context';
import { checkoutReturnUrl } from '../../shared/utilities/checkout-return';
import {
  BankAccount,
  FeePayment,
  FeePaymentAllocation,
  FeeReceipt,
  FeeRefund,
  FeeLedgerEntry,
  FeeWebhookEvent,
  PaymentGatewayConfig,
  type FeeAccount,
  type FeeInstalment,
} from './models';
import {
  accountRepo,
  allocateToInstalments,
  instalmentStatus,
  lockAccount,
  reduceInstalments,
} from './accounts.service';
import { evaluateEntitlement } from './entitlements';
import { L, bankLedger, gatewayLedger, postJournal } from './ledger';
import {
  allocateFeeNumber,
  ensureFeeSequence,
  resolveFeeNumberTarget,
  type FeeNumberTarget,
} from './numbering';
import { getFeeSettings } from './settings.service';
import {
  adapterFor,
  gatewayConfigFor,
  mockGatewayAllowed,
  resolveGateway,
  webhookUrl,
} from './gateways.service';
import { money, notifyStudent } from './notifications';
import { today, withLockRetry, auditFee } from './util';
import { recordReferralConversion, redeemCoupon, releaseCoupon, validateCoupon } from '../website/api';

export const paymentRepo = new TenantRepository(FeePayment, { branchScoped: true, entity: 'Payment' });

export function paymentDto(p: FeePayment): FeePaymentDto {
  return {
    id: p.id,
    branchId: p.branchId,
    accountId: p.accountId,
    studentId: p.studentId,
    studentName: p.student?.name,
    amount: p.amount,
    mode: p.mode,
    gateway: p.gateway,
    status: p.status,
    approvalStatus: p.approvalStatus,
    referenceNo: p.referenceNo,
    chequeNumber: p.chequeNumber,
    chequeDate: p.chequeDate,
    bankName: p.bankName,
    paidOn: p.paidOn,
    gatewayOrderId: p.gatewayOrderId,
    gatewayPaymentId: p.gatewayPaymentId,
    gatewayCharge: p.gatewayCharge,
    refunded: p.refunded,
    receiptId: p.receiptId,
    receiptNumber: p.receipt?.number ?? null,
    bankAccountId: p.bankAccountId,
    notes: p.notes,
    couponCode: p.couponCode ?? null,
    couponDiscount: p.couponDiscount ?? 0,
    referralCode: p.referralCode ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * Maps an adapter failure to an API error. Vendor messages are safe (never credentials); payers get
 * a plain message and the detail goes to the log for the institute.
 */
function gatewayError(err: unknown, payer = false): unknown {
  if (err instanceof GatewayConfigError) {
    if (payer) logger.warn({ reason: err.message }, 'Payment gateway is misconfigured');
    return new AppError(
      409,
      'GATEWAY_MISCONFIGURED',
      payer ? 'Online payment is not available right now. Please contact the institute.' : err.message,
    );
  }
  if (err instanceof GatewayRequestError) {
    if (payer)
      logger.warn(
        { gateway: err.gateway, status: err.status, code: err.code, reason: err.message },
        'Payment gateway request failed',
      );
    return new AppError(
      502,
      'GATEWAY_ERROR',
      payer
        ? err.retryable
          ? 'The payment gateway is not responding. Please try again in a few minutes.'
          : 'The payment could not be started. Please try again or contact the institute.'
        : err.message,
    );
  }
  return err;
}

/** Per-customer key used for website coupon limits (validate and redeem must agree). */
export const couponCustomerKey = (studentId: number) => `student:${studentId}`;
const couponOrderRef = (paymentId: number) => `fee-payment:${paymentId}`;
const COUPON_JOURNAL = 'payment-coupon:';
/** Pending coupon checkouts older than this give their coupon reservation back. */
const COUPON_RESERVATION_HOURS = 24;

/**
 * Applies a coupon discount to the oldest unpaid instalments (so the discounted payment still
 * clears the instalments it was priced for) and books it as a fee discount.
 */
async function applyCouponDiscount(
  payment: FeePayment,
  account: FeeAccount,
  instalments: FeeInstalment[],
  transaction: Transaction,
) {
  let left = Math.min(payment.couponDiscount, Math.max(0, account.balance));
  let applied = 0;
  for (const i of instalments) {
    if (left <= 0) break;
    const take = Math.min(Math.max(0, i.amount - Math.max(0, i.paid - i.lateFee)), left);
    if (!take) continue;
    i.amount -= take;
    i.status = instalmentStatus(i);
    await i.save({ transaction });
    left -= take;
    applied += take;
    // One journal per instalment so a full refund can restore exactly what was taken from each.
    await postJournal(
      {
        key: `${COUPON_JOURNAL}${payment.id}:${i.id}`,
        branchId: payment.branchId,
        feeAccountId: account.id,
        refType: 'payment',
        refId: payment.id,
        date: payment.paidOn ?? (await today()),
        narration: `Coupon ${payment.couponCode ?? ''} discount (${i.label})`,
        lines: [
          { account: L.FEE_INCOME, debit: take },
          { account: L.RECEIVABLE, credit: take },
        ],
      },
      transaction,
    );
  }
  account.discount += applied;
  if (applied !== payment.couponDiscount) await payment.update({ couponDiscount: applied }, { transaction });
}

/** Undoes a payment's coupon discount (full refund): instalments, account discount and journals. */
async function reverseCouponDiscount(
  payment: FeePayment,
  account: FeeAccount,
  instalments: FeeInstalment[],
  transaction: Transaction,
): Promise<number> {
  if (!payment.couponDiscount) return 0;
  const lines = await FeeLedgerEntry.findAll({
    where: {
      instituteId: payment.instituteId,
      journalKey: { [Op.like]: `${COUPON_JOURNAL}${payment.id}:%` },
      account: L.FEE_INCOME,
    },
    transaction,
  });
  let restored = 0;
  for (const l of lines) {
    const inst = instalments.find((i) => l.journalKey === `${COUPON_JOURNAL}${payment.id}:${i.id}`);
    if (!inst || !l.debit) continue;
    const posted = await postJournal(
      {
        key: `payment-coupon-reversal:${payment.id}:${inst.id}`,
        branchId: payment.branchId,
        feeAccountId: account.id,
        refType: 'payment',
        refId: payment.id,
        narration: `Coupon ${payment.couponCode ?? ''} discount reversed (${inst.label})`,
        lines: [
          { account: L.RECEIVABLE, debit: l.debit },
          { account: L.FEE_INCOME, credit: l.debit },
        ],
      },
      transaction,
    );
    if (!posted) continue;
    inst.amount += l.debit;
    inst.status = instalmentStatus(inst);
    await inst.save({ transaction });
    restored += l.debit;
  }
  account.discount -= restored;
  return restored;
}

/** Website side effects of a captured online payment (coupon use, referral purchase). */
/**
 * Confirms the coupon use of a captured payment. The use was reserved at checkout, so this is
 * normally an idempotent no-op; if the reservation was released (failed/abandoned order) it is
 * redeemed again under the coupon's limits. Returns false when the coupon can no longer be used.
 */
async function redeemPaymentCoupon(payment: FeePayment, courseId: number | null, transaction: Transaction) {
  if (!payment.couponCode) return false;
  try {
    await redeemCoupon(
      {
        code: payment.couponCode,
        amountPaise: payment.amount + payment.couponDiscount,
        courseId,
        customerKey: couponCustomerKey(payment.studentId),
        orderRef: couponOrderRef(payment.id),
      },
      { transaction },
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, paymentId: payment.id },
      'Coupon could not be redeemed; payment posted without discount',
    );
    return false;
  }
}

/** Website side effects of a captured online payment (referral purchase). */
async function recordPurchaseAttribution(payment: FeePayment, transaction: Transaction) {
  if (payment.referralCode)
    await recordReferralConversion(
      {
        code: payment.referralCode,
        kind: 'purchase',
        refType: 'fee_payment',
        refId: payment.id,
        amountPaise: payment.amount,
      },
      { transaction },
    );
}

/** Gives the coupon use back when an order is refunded in full or cancelled. Idempotent. */
async function releasePaymentCoupon(payment: FeePayment, transaction?: Transaction) {
  if (!payment.couponCode) return;
  try {
    await releaseCoupon(
      { code: payment.couponCode, orderRef: couponOrderRef(payment.id) },
      transaction ? { transaction } : {},
    );
  } catch (err) {
    logger.warn({ err, paymentId: payment.id }, 'Coupon could not be released');
  }
}

/** Ledger account the money lands in. */
export function moneyLedger(p: Pick<FeePayment, 'mode' | 'gateway' | 'bankAccountId'>): string {
  if (p.mode === 'online') return gatewayLedger(p.gateway ?? 'unknown');
  if (p.mode === 'cash') return L.CASH;
  return p.bankAccountId ? bankLedger(p.bankAccountId) : L.UNDEPOSITED;
}

interface NumberTargets {
  receipt: FeeNumberTarget;
  invoice: FeeNumberTarget | null;
}

/** Resolves and creates receipt/invoice counters outside the posting transaction. */
async function prepareNumbers(branchId: number): Promise<NumberTargets> {
  const settings = await getFeeSettings();
  const receipt = await resolveFeeNumberTarget('receipt', settings.receiptFormat, branchId);
  await ensureFeeSequence(receipt);
  let invoice: FeeNumberTarget | null = null;
  if (settings.gstEnabled) {
    invoice = await resolveFeeNumberTarget('invoice', settings.invoiceFormat, branchId);
    await ensureFeeSequence(invoice);
  }
  return { receipt, invoice };
}

async function lockPayment(id: number, transaction: Transaction) {
  const { instituteId } = requireTenantContext();
  const p = await FeePayment.findOne({
    where: { instituteId, id },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!p) throw NotFound('Payment');
  return p;
}

/**
 * Posts a locked, not-yet-posted payment: allocates to instalments (oldest first), keeps any
 * excess as advance, writes the balanced journals (money/receivable/advance, GST, gateway fee),
 * issues the receipt with a gap-free number and re-evaluates course entitlement.
 * Idempotent: a payment with `postedAt` is never posted again.
 */
async function postLocked(
  payment: FeePayment,
  targets: NumberTargets,
  transaction: Transaction,
  extra: { gatewayPaymentId?: string; gatewayCharge?: number; payload?: unknown } = {},
): Promise<FeeReceipt | null> {
  if (payment.postedAt) return null;
  const settings = await getFeeSettings();
  const { account, instalments } = await lockAccount(payment.accountId, transaction);
  if (payment.couponDiscount > 0) {
    if (account.status === 'active' && (await redeemPaymentCoupon(payment, account.courseId, transaction)))
      await applyCouponDiscount(payment, account, instalments, transaction);
    else {
      await releasePaymentCoupon(payment, transaction);
      await payment.update({ couponDiscount: 0 }, { transaction });
    }
  }
  const allocs =
    account.status === 'active' ? await allocateToInstalments(instalments, payment.amount, transaction) : [];
  const allocated = allocs.reduce((s, a) => s + a.amount, 0);
  const excess = payment.amount - allocated;
  account.paid += allocated;
  account.advance += excess;
  await account.save({ transaction });
  if (allocs.length)
    await FeePaymentAllocation.bulkCreate(
      allocs.map((a) => ({ ...a, instituteId: payment.instituteId, paymentId: payment.id })),
      { transaction },
    );
  const date = payment.paidOn ?? (await today());
  const base = {
    branchId: payment.branchId,
    feeAccountId: account.id,
    refType: 'payment',
    refId: payment.id,
    date,
  };
  await postJournal(
    {
      ...base,
      key: `payment:${payment.id}`,
      narration: `Fee payment (${payment.mode}) ${account.title}`,
      lines: [
        { account: moneyLedger(payment), debit: payment.amount },
        { account: L.RECEIVABLE, credit: allocated },
        { account: L.ADVANCE, credit: excess },
      ],
    },
    transaction,
  );
  let gst = 0;
  let taxableValue = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (settings.gstEnabled && account.gross > 0 && account.taxableGross > 0 && allocated > 0) {
    const taxablePortion = Math.round((allocated * account.taxableGross) / account.gross);
    gst = Math.round((taxablePortion * settings.gstRatePercent) / (100 + settings.gstRatePercent));
    taxableValue = taxablePortion - gst;
    if (settings.gstInterState) igst = gst;
    else {
      cgst = Math.floor(gst / 2);
      sgst = gst - cgst;
    }
    await postJournal(
      {
        ...base,
        key: `payment-gst:${payment.id}`,
        narration: 'GST on fees received',
        lines: [
          { account: L.FEE_INCOME, debit: gst },
          { account: L.GST_PAYABLE, credit: gst },
        ],
      },
      transaction,
    );
  }
  const charge = Math.max(0, Math.round(extra.gatewayCharge ?? 0));
  if (charge > 0 && payment.gateway)
    await postJournal(
      {
        ...base,
        key: `payment-fee:${payment.id}`,
        narration: `${payment.gateway} gateway charges`,
        lines: [
          { account: L.GATEWAY_CHARGES, debit: charge },
          { account: gatewayLedger(payment.gateway), credit: charge },
        ],
      },
      transaction,
    );
  const number = await allocateFeeNumber(targets.receipt, transaction);
  const invoiceNumber =
    gst > 0 && targets.invoice ? await allocateFeeNumber(targets.invoice, transaction) : null;
  const receipt = await FeeReceipt.create(
    {
      instituteId: payment.instituteId,
      branchId: payment.branchId,
      number,
      invoiceNumber,
      paymentId: payment.id,
      accountId: account.id,
      studentId: payment.studentId,
      amount: payment.amount,
      taxableValue,
      cgst,
      sgst,
      igst,
      issuedAt: new Date(),
    },
    { transaction },
  );
  await payment.update(
    {
      status: 'successful',
      postedAt: new Date(),
      receiptId: receipt.id,
      gatewayCharge: charge,
      paidOn: date,
      ...(extra.gatewayPaymentId ? { gatewayPaymentId: extra.gatewayPaymentId } : {}),
      ...(extra.payload !== undefined ? { gatewayPayload: extra.payload ?? {} } : {}),
    },
    { transaction },
  );
  await evaluateEntitlement(account, instalments, transaction);
  if (payment.mode === 'online') await recordPurchaseAttribution(payment, transaction);
  return receipt;
}

async function afterPosted(paymentId: number) {
  const { instituteId } = requireTenantContext();
  const p = await FeePayment.findOne({
    where: { instituteId, id: paymentId },
    include: ['student', 'receipt'],
  });
  if (!p?.student || !p.receipt) return;
  await notifyStudent(
    'fees.receipt',
    p.student,
    { amount: money(p.amount), receiptNo: p.receipt.number, paidOn: p.paidOn ?? (await today()) },
    p.branchId,
  );
}

async function loadPayment(id: number) {
  return paymentRepo.findById(id, { include: ['student', 'receipt'] });
}

export interface OfflinePaymentInput {
  accountId: number;
  amount: number;
  mode: OfflinePaymentMode;
  referenceNo?: string | null;
  chequeNumber?: string | null;
  chequeDate?: string | null;
  bankName?: string | null;
  bankAccountId?: number | null;
  paidOn?: string;
  notes?: string | null;
}

/** Counter/offline collection. Needs approval when the institute requires it and the user can't approve. */
export async function recordOfflinePayment(
  input: OfflinePaymentInput,
  idempotencyKey: string | null,
  canApprove: boolean,
) {
  const { instituteId, userId } = requireTenantContext();
  if (idempotencyKey) {
    const existing = await paymentRepo.findOne({ where: { idempotencyKey } });
    if (existing) return { payment: await loadPayment(existing.id), replay: true };
  }
  const account = await accountRepo.findById(input.accountId);
  if (account.status === 'cancelled') throw Conflict('Account is cancelled', 'ACCOUNT_INACTIVE');
  if (input.mode === 'cheque' && !input.chequeNumber) throw BadRequest('Cheque number is required');
  if (
    input.bankAccountId &&
    !(await BankAccount.findOne({ where: { instituteId, id: input.bankAccountId, active: true } }))
  )
    throw BadRequest('Bank account not found');
  const settings = await getFeeSettings();
  const needsApproval = settings.offlineApprovalRequired && !canApprove;
  const targets = needsApproval ? null : await prepareNumbers(account.branchId);
  let paymentId: number;
  try {
    paymentId = await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => {
        // Lock the account before inserting: the payment's FK check would otherwise take a shared
        // lock that concurrent postings then deadlock upgrading.
        if (targets) await lockAccount(account.id, transaction);
        const payment = await FeePayment.create(
          {
            instituteId,
            branchId: account.branchId,
            accountId: account.id,
            studentId: account.studentId,
            amount: input.amount,
            mode: input.mode,
            gateway: null,
            status: 'pending',
            approvalStatus: needsApproval ? 'pending' : 'not_required',
            referenceNo: input.referenceNo ?? null,
            chequeNumber: input.chequeNumber ?? null,
            chequeDate: input.chequeDate ?? null,
            bankName: input.bankName ?? null,
            paidOn: input.paidOn ?? (await today()),
            gatewayOrderId: null,
            idempotencyKey,
            bankAccountId: input.bankAccountId ?? null,
            recordedByUserId: userId ?? null,
            notes: input.notes ?? null,
          },
          { transaction },
        );
        if (targets) await postLocked(payment, targets, transaction);
        return payment.id;
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError' && idempotencyKey) {
      const existing = await paymentRepo.findOne({ where: { idempotencyKey } });
      if (existing) return { payment: await loadPayment(existing.id), replay: true };
    }
    throw err;
  }
  const payment = await loadPayment(paymentId);
  await auditFee({
    action: 'fees.payment.record',
    entityType: 'fee_payment',
    entityId: paymentId,
    after: paymentDto(payment),
  });
  if (payment.status === 'successful') await afterPosted(paymentId);
  return { payment, replay: false };
}

export async function decideOfflinePayment(id: number, approve: boolean, reason?: string) {
  const { userId } = requireTenantContext();
  const current = await paymentRepo.findById(id);
  if (current.approvalStatus !== 'pending' || current.status !== 'pending')
    throw Conflict('Payment is not awaiting approval', 'NOT_PENDING');
  const targets = approve ? await prepareNumbers(current.branchId) : null;
  await withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      const p = await lockPayment(id, transaction);
      if (p.approvalStatus !== 'pending' || p.status !== 'pending')
        throw Conflict('Payment is not awaiting approval', 'NOT_PENDING');
      await p.update(
        {
          approvalStatus: approve ? 'approved' : 'rejected',
          approvedByUserId: userId ?? null,
          ...(approve
            ? {}
            : {
                status: 'cancelled',
                notes: reason ? `${p.notes ?? ''}\nRejected: ${reason}`.trim() : p.notes,
              }),
        },
        { transaction },
      );
      if (targets) await postLocked(p, targets, transaction);
    }),
  );
  const payment = await loadPayment(id);
  await auditFee({
    action: approve ? 'fees.payment.approve' : 'fees.payment.reject',
    entityType: 'fee_payment',
    entityId: id,
    before: { approvalStatus: 'pending' },
    after: { approvalStatus: payment.approvalStatus, status: payment.status, reason },
  });
  if (approve) await afterPosted(id);
  return payment;
}

/** Starts an online payment: creates the pending payment and the gateway order. */
export async function createCheckout(input: {
  accountId: number;
  amount?: number;
  gateway?: PaymentGatewayKey;
  idempotencyKey?: string | null;
  /** Website coupon: validated now (discount lowers the amount), redeemed once captured. */
  couponCode?: string | null;
  /** Website referral code credited with a purchase once captured. */
  referralCode?: string | null;
  /** Where the vendor's hosted checkout sends the payer back to (web, Android or iOS app). */
  returnTo?: CheckoutReturnInput | null;
  /** Student/parent self-service: gateway problems are reported in plain words. */
  payer?: boolean;
}): Promise<CheckoutOrderDto> {
  const { instituteId, userId } = requireTenantContext();
  const account = await accountRepo.findById(input.accountId, { include: ['student'] });
  if (account.status !== 'active') throw Conflict('Account is not active', 'ACCOUNT_INACTIVE');
  const amount = input.amount ?? account.balance;
  if (!Number.isInteger(amount) || amount <= 0) throw BadRequest('Nothing to pay on this account');
  const cfg = await resolveGateway(input.gateway);
  const gateway = adapterFor(cfg);
  const key = input.idempotencyKey ?? null;
  if (key) {
    const existing = await paymentRepo.findOne({ where: { idempotencyKey: key } });
    if (existing?.gatewayOrderId)
      return {
        paymentId: existing.id,
        gateway: existing.gateway!,
        gatewayOrderId: existing.gatewayOrderId,
        amount: existing.amount,
        discount: existing.couponDiscount,
        couponCode: existing.couponCode,
        checkout: (existing.gatewayPayload as Record<string, unknown>) ?? {},
      };
    if (existing)
      throw existing.status === 'failed'
        ? Conflict('This payment could not be started; start a new one', 'CHECKOUT_FAILED')
        : Conflict('This payment is still being started; try again in a moment', 'CHECKOUT_IN_PROGRESS');
  }
  const referralCode = input.referralCode?.trim().toUpperCase().slice(0, 40) || null;
  const requested = input.couponCode?.trim().toUpperCase() || null;
  let couponCode: string | null = null;
  let discount = 0;
  let payable = amount;
  let payment: FeePayment;
  try {
    payment = await getSequelize().transaction(async (transaction) => {
      if (requested) {
        // A new checkout supersedes this student's earlier unpaid checkouts with the same coupon:
        // their reservations go back first (if one is paid later it is re-redeemed under the
        // limits, or posted without the discount).
        const stale = await FeePayment.findAll({
          where: {
            instituteId,
            studentId: account.studentId,
            mode: 'online',
            status: 'pending',
            couponCode: requested,
          },
          transaction,
        });
        for (const s of stale) await releasePaymentCoupon(s, transaction);
        const v = await validateCoupon(
          {
            code: requested,
            amountPaise: Math.min(amount, Math.max(0, account.balance)),
            courseId: account.courseId,
            customerKey: couponCustomerKey(account.studentId),
          },
          { transaction },
        );
        if (!v.valid) throw Conflict(v.message, `COUPON_${v.reason}`);
        if (v.discountPaise >= amount)
          throw Conflict('This coupon covers the whole amount; ask the institute to apply it', 'COUPON_FULL');
        couponCode = v.code;
        discount = v.discountPaise;
        payable = amount - discount;
      }
      const created = await FeePayment.create(
        {
          instituteId,
          branchId: account.branchId,
          accountId: account.id,
          studentId: account.studentId,
          amount: payable,
          mode: 'online',
          gateway: cfg.gateway,
          referenceNo: null,
          chequeNumber: null,
          chequeDate: null,
          bankName: null,
          paidOn: null,
          gatewayOrderId: null,
          idempotencyKey: key,
          bankAccountId: null,
          recordedByUserId: userId ?? null,
          notes: null,
          couponCode,
          couponDiscount: discount,
          referralCode,
        },
        { transaction },
      );
      // Reserve the coupon use now so it counts against usage and per-customer limits while the
      // order is open; capture confirms it, failure/cancel/expiry releases it.
      if (couponCode)
        await redeemCoupon(
          {
            code: couponCode,
            amountPaise: Math.min(amount, Math.max(0, account.balance)),
            courseId: account.courseId,
            customerKey: couponCustomerKey(account.studentId),
            orderRef: couponOrderRef(created.id),
          },
          { transaction },
        );
      return created;
    });
  } catch (err) {
    // The same Idempotency-Key raced in from a double tap: the first request owns the checkout.
    if (
      key &&
      (err as { name?: string }).name === 'SequelizeUniqueConstraintError' &&
      (await paymentRepo.findOne({ where: { idempotencyKey: key } }))
    )
      throw Conflict('This payment is still being started; try again in a moment', 'CHECKOUT_IN_PROGRESS');
    throw err;
  }
  let order: GatewayOrder;
  try {
    order = await gateway.createOrder({
      orderId: `${instituteId}-${payment.id}`,
      amountPaise: payable,
      currency: 'INR',
      customer: {
        id: `stu${account.studentId}`,
        name: account.student?.name ?? 'Student',
        mobile: account.student?.mobile ?? '',
        email: account.student?.email ?? undefined,
      },
      callbackUrl: checkoutReturnUrl(
        'fees',
        { instituteId, paymentId: payment.id },
        input.returnTo ?? undefined,
        '/my-fees',
      ),
      notifyUrl: webhookUrl(cfg),
      description: `Fees: ${account.title}`.slice(0, 80),
      metadata: { instituteId: String(instituteId), paymentId: String(payment.id) },
    });
  } catch (err) {
    // No order exists at the gateway, so nothing can be paid: free the coupon reservation now.
    await payment.update({ status: 'failed' });
    await releasePaymentCoupon(payment);
    throw gatewayError(err, input.payer);
  }
  await payment.update({ gatewayOrderId: order.gatewayOrderId, gatewayPayload: order.checkout });
  await auditFee({
    action: 'fees.payment.checkout',
    entityType: 'fee_payment',
    entityId: payment.id,
    after: { amount: payable, gateway: cfg.gateway, couponCode, discount, referralCode },
  });
  return {
    paymentId: payment.id,
    gateway: cfg.gateway,
    gatewayOrderId: order.gatewayOrderId,
    amount: payable,
    discount,
    couponCode,
    checkout: order.checkout,
  };
}

export type WebhookOutcome =
  | 'posted'
  | 'failed'
  | 'duplicate'
  | 'already_processed'
  | 'unmatched'
  | 'amount_mismatch'
  | 'pending'
  | 'ignored'
  | 'refund_processed'
  | 'refund_failed'
  | 'refund_pending';

/**
 * Applies a verified gateway status. The (gateway, event key) row in `fee_webhook_events` is
 * inserted in the same transaction as the posting, so a replayed event is rejected by the unique
 * index; a different event for an already posted payment is a no-op because the payment row is
 * locked and `postedAt` is checked.
 */
async function applyVerified(
  cfg: PaymentGatewayConfig,
  v: VerifiedPayment,
  eventKey: string,
): Promise<WebhookOutcome> {
  const { instituteId } = requireTenantContext();
  const pre = await FeePayment.findOne({
    where: { instituteId, gateway: cfg.gateway, gatewayOrderId: v.gatewayOrderId },
  });
  const targets = pre && v.status === 'success' && !pre.postedAt ? await prepareNumbers(pre.branchId) : null;
  let outcome = 'pending' as WebhookOutcome;
  try {
    await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => {
        const event = await FeeWebhookEvent.create(
          {
            instituteId,
            gateway: cfg.gateway,
            eventKey: eventKey.slice(0, 160),
            gatewayOrderId: v.gatewayOrderId,
            status: 'received',
            payload: v.raw ?? null,
          },
          { transaction },
        );
        const p = pre ? await lockPayment(pre.id, transaction) : null;
        if (!p) outcome = 'unmatched';
        else if (v.status === 'success') {
          if (p.postedAt) outcome = 'already_processed';
          else if (v.amountPaise !== p.amount) {
            outcome = 'amount_mismatch';
            logger.error(
              { paymentId: p.id, expected: p.amount, got: v.amountPaise },
              'Gateway amount mismatch',
            );
          } else {
            // Money arrived for a cancelled order: still post it (as advance if needed) — never lose funds.
            if (p.status === 'cancelled') await p.update({ status: 'pending' }, { transaction });
            if (v.bankReference && !p.referenceNo)
              await p.update({ referenceNo: v.bankReference.slice(0, 120) }, { transaction });
            await postLocked(p, targets!, transaction, {
              gatewayPaymentId: v.gatewayPaymentId,
              gatewayCharge: v.feePaise,
              payload: v.raw,
            });
            outcome = 'posted';
          }
        } else if (v.status === 'failed') {
          if (p.status === 'pending') {
            await p.update(
              { status: 'failed', gatewayPaymentId: v.gatewayPaymentId || null },
              { transaction },
            );
            await releasePaymentCoupon(p, transaction);
            outcome = 'failed';
          } else outcome = 'already_processed';
        }
        await event.update({ status: outcome }, { transaction });
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      const dup = await FeeWebhookEvent.findOne({
        where: { instituteId, gateway: cfg.gateway, eventKey: eventKey.slice(0, 160) },
      });
      if (dup) return 'duplicate';
    }
    throw err;
  }
  if (pre && outcome === 'posted') await afterPosted(pre.id);
  if (pre && outcome === 'failed') {
    const p = await FeePayment.findOne({ where: { instituteId, id: pre.id }, include: ['student'] });
    if (p?.student)
      await notifyStudent('fees.payment-failed', p.student, { amount: money(p.amount) }, p.branchId);
  }
  return outcome;
}

/**
 * Public webhook entry point. The institute is resolved from the unguessable per-config webhook
 * key; the body signature is verified with that institute's secret before anything is trusted.
 * A disabled gateway still accepts signed events so payments and refunds already started settle.
 */
export async function processWebhook(
  gatewayName: string,
  webhookKey: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ outcome: WebhookOutcome; paymentId: number | null }> {
  // Platform lookup: the webhook is unauthenticated, the key identifies the institute's config.
  const cfg = await PaymentGatewayConfig.findOne({
    where: { gateway: gatewayName, webhookKey },
    tenantBypass: true,
  } as Parameters<typeof PaymentGatewayConfig.findOne>[0]);
  if (!cfg || (cfg.gateway === 'mock' && !mockGatewayAllowed())) throw NotFound('Webhook');
  return runWithContext({ system: true, instituteId: cfg.instituteId, allowedBranchIds: null }, async () => {
    let event: GatewayWebhookEvent;
    try {
      event = await adapterFor(cfg).verifyWebhook(headers, rawBody);
    } catch (err) {
      if (err instanceof WebhookSignatureError)
        throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
      // Signed, but the follow-up status call failed: a 5xx makes the vendor deliver it again.
      if (err instanceof GatewayRequestError && err.retryable)
        throw new AppError(503, 'GATEWAY_UNAVAILABLE', 'Gateway status check failed; retry later');
      logger.warn(
        { gateway: cfg.gateway, instituteId: cfg.instituteId, reason: (err as Error).message },
        'Payment webhook rejected',
      );
      throw new AppError(400, 'INVALID_WEBHOOK', (err as Error).message);
    }
    if (event.kind === 'ignored') return { outcome: 'ignored' as const, paymentId: null };
    if (event.kind === 'refund') return applyRefundEvent(cfg, event);
    const eventKey = event.eventId ?? `${event.gatewayPaymentId || event.gatewayOrderId}:${event.status}`;
    const outcome = await applyVerified(cfg, event, eventKey);
    const p = await FeePayment.findOne({
      where: { instituteId: cfg.instituteId, gateway: cfg.gateway, gatewayOrderId: event.gatewayOrderId },
      attributes: ['id'],
    });
    return { outcome, paymentId: p?.id ?? null };
  });
}

/** Simulates the hosted checkout of the mock gateway and delivers its signed webhook. */
export async function completeMockCheckout(paymentId: number, outcome: 'success' | 'failed') {
  if (!mockGatewayAllowed()) throw NotFound('Payment');
  const payment = await paymentRepo.findById(paymentId);
  if (payment.gateway !== 'mock' || !payment.gatewayOrderId) throw BadRequest('Not a mock gateway payment');
  const cfg = await resolveGateway('mock');
  const gateway = adapterFor(cfg) as MockPaymentGateway;
  const { body, headers } = gateway.completeCheckout(payment.gatewayOrderId, outcome, payment.amount);
  return processWebhook('mock', cfg.webhookKey, Buffer.from(body), headers);
}

/** Applies a server-side status check; `pending` changes nothing. */
async function applyStatus(cfg: PaymentGatewayConfig, v: VerifiedPayment): Promise<WebhookOutcome> {
  if (v.status === 'pending') return 'pending';
  return applyVerified(cfg, v, `status:${v.gatewayPaymentId || v.gatewayOrderId}:${v.status}`);
}

/** Server-side status check (fallback when a webhook was missed). */
export async function syncPaymentStatus(id: number, opts: { payer?: boolean } = {}) {
  const payment = await paymentRepo.findById(id);
  if (payment.mode !== 'online' || !payment.gateway || !payment.gatewayOrderId)
    throw BadRequest('Not an online payment');
  const cfg = await gatewayConfigFor(payment.gateway);
  let v: VerifiedPayment;
  try {
    v = await adapterFor(cfg).fetchStatus(payment.gatewayOrderId);
  } catch (err) {
    throw gatewayError(err, opts.payer);
  }
  return { outcome: await applyStatus(cfg, v), payment: await loadPayment(id) };
}

/**
 * The payer is back from the vendor's hosted checkout (signed return link): confirm the outcome
 * with the gateway now rather than waiting for the webhook. Nothing from the browser is trusted.
 */
export async function syncReturnedPayment(instituteId: number, paymentId: number): Promise<void> {
  await runWithContext({ system: true, instituteId, allowedBranchIds: null }, async () => {
    const p = await FeePayment.findOne({ where: { instituteId, id: paymentId } });
    if (!p || p.mode !== 'online' || !p.gateway || !p.gatewayOrderId || p.postedAt) return;
    if (p.status !== 'pending' && p.status !== 'failed') return;
    const cfg = await gatewayConfigFor(p.gateway);
    await applyStatus(cfg, await adapterFor(cfg).fetchStatus(p.gatewayOrderId));
  });
}

/** Reverses `amount` of a posted payment inside a transaction (refund / cancellation). */
async function reverseLocked(
  p: FeePayment,
  amount: number,
  key: string,
  opts: { reduceDues: boolean; narration: string; restoreCoupon?: boolean },
  transaction: Transaction,
) {
  const { account, instalments } = await lockAccount(p.accountId, transaction);
  const fromAdvance = Math.min(account.advance, amount);
  let fromDues = amount - fromAdvance;
  account.advance -= fromAdvance;
  account.paid -= fromDues;
  for (const i of [...instalments].sort((a, b) => b.seq - a.seq)) {
    if (fromDues <= 0) break;
    const take = Math.min(i.paid, fromDues);
    if (!take) continue;
    i.paid -= take;
    i.status = instalmentStatus(i);
    await i.save({ transaction });
    fromDues -= take;
  }
  const reopened = amount - fromAdvance;
  const base = { branchId: p.branchId, feeAccountId: account.id, refType: 'payment', refId: p.id };
  await postJournal(
    {
      ...base,
      key,
      narration: opts.narration,
      lines: [
        { account: L.ADVANCE, debit: fromAdvance },
        { account: L.RECEIVABLE, debit: reopened },
        { account: moneyLedger(p), credit: amount },
      ],
    },
    transaction,
  );
  const receipt = p.receiptId
    ? await FeeReceipt.findOne({ where: { instituteId: p.instituteId, id: p.receiptId }, transaction })
    : null;
  const gstTotal = receipt ? receipt.cgst + receipt.sgst + receipt.igst : 0;
  const gstBack = gstTotal ? Math.round((gstTotal * amount) / p.amount) : 0;
  if (gstBack)
    await postJournal(
      {
        ...base,
        key: `${key}:gst`,
        narration: 'GST reversed on refund',
        lines: [
          { account: L.GST_PAYABLE, debit: gstBack },
          { account: L.FEE_INCOME, credit: gstBack },
        ],
      },
      transaction,
    );
  const restored = opts.restoreCoupon ? await reverseCouponDiscount(p, account, instalments, transaction) : 0;
  if (opts.reduceDues && reopened + restored > 0) {
    const writeOff = Math.min(reopened + restored, Math.max(0, account.net - account.paid));
    if (writeOff > 0) {
      await reduceInstalments(instalments, writeOff, transaction);
      account.discount += writeOff;
      await postJournal(
        {
          ...base,
          key: `${key}:writeoff`,
          narration: 'Dues cancelled with refund',
          lines: [
            { account: L.FEE_INCOME, debit: writeOff },
            { account: L.RECEIVABLE, credit: writeOff },
          ],
        },
        transaction,
      );
    }
  }
  await account.save({ transaction });
  await evaluateEntitlement(account, instalments, transaction);
  return receipt;
}

const REFUND_REF = /^rf(\d+)x(\d+)x[0-9a-f]{8}$/;

/**
 * Our refund reference at the gateway: unique per refund (the key hash keeps it unique even if row
 * IDs are reused, e.g. after a database restore), at most 40 characters, matched back on webhooks.
 */
export function gatewayRefundRef(r: Pick<FeeRefund, 'instituteId' | 'id' | 'idempotencyKey'>): string {
  return `rf${r.instituteId}x${r.id}x${sha256(r.idempotencyKey).slice(0, 8)}`;
}

async function lockRefund(id: number, transaction: Transaction) {
  const { instituteId } = requireTenantContext();
  const r = await FeeRefund.findOne({
    where: { instituteId, id },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!r) throw NotFound('Refund');
  return r;
}

/** Posts a pending refund of a locked payment: reversing journals, refunded total, coupon release. */
async function settleRefundLocked(
  p: FeePayment,
  r: FeeRefund,
  transaction: Transaction,
  gatewayRefundId?: string | null,
) {
  if (r.amount > p.amount - p.refunded)
    throw Conflict('Refund exceeds the refundable amount', 'NOT_REFUNDABLE');
  await reverseLocked(
    p,
    r.amount,
    `refund:${r.id}`,
    {
      reduceDues: r.reduceDues,
      narration: `Refund${r.reason ? `: ${r.reason}` : ''}`,
      restoreCoupon: p.refunded + r.amount >= p.amount,
    },
    transaction,
  );
  const refunded = p.refunded + r.amount;
  await p.update(
    { refunded, status: refunded >= p.amount ? 'refunded' : 'partially_refunded' },
    { transaction },
  );
  if (refunded >= p.amount) await releasePaymentCoupon(p, transaction);
  await r.update(
    {
      status: 'processed',
      processedAt: new Date(),
      ...(gatewayRefundId ? { gatewayRefundId: gatewayRefundId.slice(0, 120) } : {}),
    },
    { transaction },
  );
}

/**
 * Applies the gateway's refund state. Only a pending refund changes, under the payment and refund
 * locks, with the event row in the same transaction: the original request, webhooks and
 * reconciliation polls can all report the same refund without posting it twice.
 */
async function applyRefundResult(
  cfg: PaymentGatewayConfig,
  refundId: number,
  result: RefundResult,
  eventKey: string,
): Promise<WebhookOutcome> {
  const { instituteId } = requireTenantContext();
  const key = eventKey.slice(0, 160);
  const gatewayRefundId = result.gatewayRefundId?.slice(0, 120) ?? null;
  let outcome: WebhookOutcome = 'refund_pending';
  try {
    await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => {
        const event = await FeeWebhookEvent.create(
          {
            instituteId,
            gateway: cfg.gateway,
            eventKey: key,
            gatewayOrderId: null,
            status: 'received',
            payload: result.raw ?? null,
          },
          { transaction },
        );
        const pre = await FeeRefund.findOne({ where: { instituteId, id: refundId }, transaction });
        if (!pre) throw NotFound('Refund');
        const p = await lockPayment(pre.paymentId, transaction);
        const r = await lockRefund(refundId, transaction);
        if (r.status !== 'pending') {
          if (r.status === 'failed' && result.status === 'processed')
            logger.error(
              { refundId: r.id, paymentId: p.id, gateway: cfg.gateway },
              'Gateway reports a refund we marked failed as processed; check the gateway dashboard',
            );
          outcome = 'already_processed';
        } else if (result.status === 'processed') {
          await settleRefundLocked(p, r, transaction, gatewayRefundId);
          outcome = 'refund_processed';
        } else if (result.status === 'failed') {
          await r.update(
            {
              status: 'failed',
              processedAt: new Date(),
              gatewayRefundId: gatewayRefundId ?? r.gatewayRefundId,
            },
            { transaction },
          );
          outcome = 'refund_failed';
        } else if (gatewayRefundId && gatewayRefundId !== r.gatewayRefundId) {
          await r.update({ gatewayRefundId }, { transaction });
        }
        await event.update({ status: outcome, gatewayOrderId: p.gatewayOrderId }, { transaction });
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      const dup = await FeeWebhookEvent.findOne({
        where: { instituteId, gateway: cfg.gateway, eventKey: key },
      });
      if (dup) return 'duplicate';
    }
    throw err;
  }
  return outcome;
}

/** Side effects of a refund settled by the gateway later (webhook or reconciliation). */
async function afterRefundChanged(refundId: number, outcome: WebhookOutcome) {
  if (outcome !== 'refund_processed' && outcome !== 'refund_failed') return;
  const { instituteId } = requireTenantContext();
  const r = await FeeRefund.findOne({ where: { instituteId, id: refundId } });
  if (!r) return;
  await auditFee({
    action: 'fees.payment.refund.update',
    entityType: 'fee_payment',
    entityId: r.paymentId,
    after: { refundId: r.id, amount: r.amount, status: r.status, gatewayRefundId: r.gatewayRefundId },
  });
  if (outcome === 'refund_failed') {
    logger.warn({ instituteId, refundId: r.id, paymentId: r.paymentId }, 'Gateway refund failed');
    return;
  }
  const p = await FeePayment.findOne({
    where: { instituteId, id: r.paymentId },
    include: ['student', 'receipt'],
  });
  if (p?.student)
    await notifyStudent(
      'fees.refund',
      p.student,
      { amount: money(r.amount), receiptNo: p.receipt?.number ?? '-' },
      p.branchId,
    );
}

/** Finds the refund a verified gateway refund event is about (our reference, else the vendor ID). */
async function refundForEvent(
  cfg: PaymentGatewayConfig,
  refund: Extract<GatewayWebhookEvent, { kind: 'refund' }>['refund'],
): Promise<FeeRefund | null> {
  const { instituteId } = requireTenantContext();
  let r: FeeRefund | null = null;
  const m = REFUND_REF.exec(refund.refundId ?? '');
  if (m && Number(m[1]) === instituteId) {
    r = await FeeRefund.findOne({ where: { instituteId, id: Number(m[2]) } });
    if (r && gatewayRefundRef(r) !== refund.refundId) r = null;
  }
  if (!r && refund.gatewayRefundId)
    r = await FeeRefund.findOne({
      where: { instituteId, gatewayRefundId: refund.gatewayRefundId.slice(0, 120) },
    });
  if (!r) return null;
  const p = await FeePayment.findOne({
    where: { instituteId, id: r.paymentId },
    attributes: ['id', 'gateway'],
  });
  return p?.gateway === cfg.gateway ? r : null;
}

async function applyRefundEvent(
  cfg: PaymentGatewayConfig,
  event: Extract<GatewayWebhookEvent, { kind: 'refund' }>,
): Promise<{ outcome: WebhookOutcome; paymentId: number | null }> {
  const r = await refundForEvent(cfg, event.refund);
  if (!r) return { outcome: 'unmatched', paymentId: null };
  const eventKey =
    event.eventId ?? `refund:${event.refund.gatewayRefundId ?? event.refund.refundId}:${event.refund.status}`;
  const outcome = await applyRefundResult(cfg, r.id, event.refund, eventKey);
  await afterRefundChanged(r.id, outcome);
  return { outcome, paymentId: r.paymentId };
}

/**
 * Refunds a payment. The amount is reserved first (pending refunds count against what is left),
 * offline refunds post at once, and online ones go to the gateway with a stable reference: a
 * processed answer posts now; pending or unknown outcomes settle later through the gateway's
 * webhook or reconciliation, through the same idempotent path.
 */
export async function refundPayment(
  id: number,
  input: { amount?: number; reason?: string | null; reduceDues?: boolean },
  idempotencyKey: string | null,
) {
  const { instituteId, userId } = requireTenantContext();
  const payment = await paymentRepo.findById(id, { include: ['student'] });
  const replay = async (existing: FeeRefund) => {
    if (existing.paymentId !== id) throw Conflict('Idempotency key already used', 'IDEMPOTENCY_CONFLICT');
    return { refund: existing, payment: await loadPayment(id), replay: true };
  };
  if (idempotencyKey) {
    const existing = await FeeRefund.findOne({ where: { instituteId, idempotencyKey } });
    if (existing) return replay(existing);
  }
  const online = payment.mode === 'online' && !!payment.gateway;
  if (online && ['successful', 'partially_refunded'].includes(payment.status) && !payment.gatewayPaymentId)
    throw Conflict(
      'The gateway payment reference is missing; refund it from the gateway dashboard',
      'GATEWAY_PAYMENT_UNKNOWN',
    );
  const cfg = online ? await gatewayConfigFor(payment.gateway!) : null;
  const key = idempotencyKey ?? crypto.randomUUID();
  let refund: FeeRefund;
  try {
    refund = await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => {
        const p = await lockPayment(id, transaction);
        if (!['successful', 'partially_refunded'].includes(p.status))
          throw Conflict('Only successful payments can be refunded', 'NOT_REFUNDABLE');
        const inFlight = (
          await FeeRefund.findAll({
            where: { instituteId, paymentId: id, status: 'pending' },
            attributes: ['amount'],
            transaction,
          })
        ).reduce((s, r) => s + r.amount, 0);
        const refundable = p.amount - p.refunded - inFlight;
        if (refundable <= 0)
          throw Conflict(
            inFlight ? 'A refund of this payment is still being processed' : 'Nothing left to refund',
            'NOT_REFUNDABLE',
          );
        const amount = input.amount ?? refundable;
        if (amount <= 0 || amount > refundable)
          throw BadRequest(`Refund must be between 1 and ${refundable} paise`);
        return FeeRefund.create(
          {
            instituteId,
            paymentId: id,
            amount,
            reason: input.reason ?? null,
            reduceDues: input.reduceDues ?? false,
            idempotencyKey: key,
            requestedByUserId: userId ?? null,
          },
          { transaction },
        );
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      const existing = await FeeRefund.findOne({ where: { instituteId, idempotencyKey: key } });
      if (existing) return replay(existing);
    }
    throw err;
  }
  let failure: unknown = null;
  if (!cfg) {
    await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => {
        const p = await lockPayment(id, transaction);
        const r = await lockRefund(refund.id, transaction);
        if (r.status === 'pending') await settleRefundLocked(p, r, transaction);
      }),
    );
  } else {
    let result: RefundResult | null = null;
    try {
      result = await adapterFor(cfg).refund({
        gatewayOrderId: payment.gatewayOrderId ?? '',
        gatewayPaymentId: payment.gatewayPaymentId!,
        amountPaise: refund.amount,
        refundId: gatewayRefundRef(refund),
        note: refund.reason?.slice(0, 200) || undefined,
      });
    } catch (err) {
      // Unknown outcome (timeout, 5xx, unexpected reply): stays pending until the gateway answers.
      if (err instanceof GatewayConfigError || (err instanceof GatewayRequestError && !err.retryable))
        failure = gatewayError(err);
      else if (err instanceof GatewayRequestError)
        logger.warn(
          { refundId: refund.id, gateway: cfg.gateway, reason: err.message },
          'Refund outcome unknown; reconciliation will check it',
        );
      else throw err;
    }
    if (result?.status === 'failed')
      failure = Conflict(
        result.message
          ? `The gateway rejected the refund: ${result.message}`
          : 'The gateway rejected the refund',
        'GATEWAY_REFUND_FAILED',
      );
    if (failure)
      await FeeRefund.update(
        {
          status: 'failed',
          processedAt: new Date(),
          gatewayRefundId: result?.gatewayRefundId?.slice(0, 120) ?? null,
        },
        { where: { instituteId, id: refund.id, status: 'pending' } },
      );
    else if (result)
      await applyRefundResult(
        cfg,
        refund.id,
        result,
        `refund:${result.gatewayRefundId ?? gatewayRefundRef(refund)}:${result.status}`,
      );
  }
  const saved = (await FeeRefund.findOne({ where: { instituteId, id: refund.id } }))!;
  const after = await loadPayment(id);
  await auditFee({
    action: 'fees.payment.refund',
    entityType: 'fee_payment',
    entityId: id,
    before: { refunded: payment.refunded },
    after: { refunded: after.refunded, refundId: saved.id, amount: saved.amount, status: saved.status },
  });
  if (failure) throw failure;
  if (saved.status === 'processed' && after.student)
    await notifyStudent(
      'fees.refund',
      after.student,
      { amount: money(saved.amount), receiptNo: after.receipt?.number ?? '-' },
      after.branchId,
    );
  return { refund: saved, payment: after, replay: false };
}

/**
 * Cancels a payment: pending ones simply stop; a posted offline payment (e.g. a bounced cheque)
 * is fully reversed and its receipt is marked cancelled. Online payments are refunded instead.
 */
export async function cancelPayment(id: number, reason: string | null) {
  const payment = await paymentRepo.findById(id);
  const before = paymentDto(payment);
  if (payment.status === 'pending') {
    await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => {
        const p = await lockPayment(id, transaction);
        if (p.status !== 'pending') throw Conflict('Payment status changed, retry', 'STATUS_CHANGED');
        await p.update(
          {
            status: 'cancelled',
            approvalStatus: p.approvalStatus === 'pending' ? 'rejected' : p.approvalStatus,
          },
          { transaction },
        );
        await releasePaymentCoupon(p, transaction);
      }),
    );
  } else if (payment.status === 'successful' && payment.mode !== 'online' && payment.refunded === 0) {
    await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => {
        const p = await lockPayment(id, transaction);
        if (p.status !== 'successful' || p.refunded)
          throw Conflict('Payment status changed, retry', 'STATUS_CHANGED');
        const receipt = await reverseLocked(
          p,
          p.amount,
          `payment-cancel:${p.id}`,
          { reduceDues: false, narration: `Payment cancelled${reason ? `: ${reason}` : ''}` },
          transaction,
        );
        if (receipt) await receipt.update({ status: 'cancelled', pdfFileId: null }, { transaction });
        await p.update(
          { status: 'cancelled', notes: reason ? `${p.notes ?? ''}\nCancelled: ${reason}`.trim() : p.notes },
          { transaction },
        );
      }),
    );
  } else {
    throw Conflict(
      'Only pending or unrefunded offline payments can be cancelled; refund online payments instead',
      'NOT_CANCELLABLE',
    );
  }
  const after = await loadPayment(id);
  await auditFee({
    action: 'fees.payment.cancel',
    entityType: 'fee_payment',
    entityId: id,
    before,
    after: { ...paymentDto(after), reason },
  });
  return after;
}

/**
 * Releases coupon reservations held by online checkouts that were never paid. Idempotent; a late
 * capture re-redeems the coupon if it is still within its limits.
 */
export async function releaseStaleCouponReservations(now = new Date()): Promise<number> {
  const { instituteId } = requireTenantContext();
  const stale = await FeePayment.findAll({
    where: {
      instituteId,
      mode: 'online',
      status: { [Op.in]: ['pending', 'failed'] },
      postedAt: null,
      couponCode: { [Op.ne]: null },
      createdAt: {
        [Op.lt]: new Date(now.getTime() - COUPON_RESERVATION_HOURS * 3_600_000),
        [Op.gte]: new Date(now.getTime() - 30 * 24 * 3_600_000),
      },
    },
    limit: 500,
  });
  let released = 0;
  for (const p of stale)
    if (await releaseCoupon({ code: p.couponCode!, orderRef: couponOrderRef(p.id) }).catch(() => false))
      released++;
  return released;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Open items due for a gateway check, backing off with age: every run in the first hour, hourly
 * for a day, then every six hours. A check that changes nothing touches `updatedAt`.
 */
function dueForCheck(now: Date, maxAge: number) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  return [
    { createdAt: { [Op.lte]: ago(2 * MINUTE), [Op.gt]: ago(HOUR) } },
    { createdAt: { [Op.lte]: ago(HOUR), [Op.gt]: ago(24 * HOUR) }, updatedAt: { [Op.lte]: ago(HOUR) } },
    { createdAt: { [Op.lte]: ago(24 * HOUR), [Op.gt]: ago(maxAge) }, updatedAt: { [Op.lte]: ago(6 * HOUR) } },
  ];
}

/**
 * Asks the gateways about this institute's open online payments and refunds: the safety net for
 * missed webhooks and unknown outcomes. Results go through the same idempotent paths as webhooks,
 * so a webhook, a poll and a payer's return can never post a payment or a refund twice.
 */
export async function reconcileGatewayPayments(
  now = new Date(),
): Promise<{ payments: number; refunds: number; errors: number }> {
  const { instituteId } = requireTenantContext();
  const stats = { payments: 0, refunds: 0, errors: 0 };
  const gateways = new Map<string, { cfg: PaymentGatewayConfig; adapter: PaymentGateway } | null>();
  const gatewayOf = async (name: PaymentGatewayKey) => {
    if (!gateways.has(name)) {
      try {
        const cfg = await gatewayConfigFor(name);
        gateways.set(name, { cfg, adapter: adapterFor(cfg) });
      } catch (err) {
        logger.warn(
          { instituteId, gateway: name, reason: (err as Error).message },
          'Gateway not reconcilable',
        );
        gateways.set(name, null);
      }
    }
    return gateways.get(name)!;
  };
  const fail = (err: unknown, item: Record<string, unknown>) => {
    stats.errors++;
    logger.warn(
      { instituteId, ...item, reason: (err as Error).message },
      'Gateway reconciliation item failed',
    );
  };

  const payments = await FeePayment.findAll({
    where: {
      instituteId,
      mode: 'online',
      gateway: { [Op.ne]: null },
      gatewayOrderId: { [Op.ne]: null },
      postedAt: null,
      [Op.or]: [
        { status: 'pending', [Op.or]: dueForCheck(now, 72 * HOUR) },
        // A failed attempt can be followed by a successful one on the same order.
        { status: 'failed', updatedAt: { [Op.gt]: new Date(now.getTime() - HOUR) } },
      ],
    },
    order: [['id', 'ASC']],
    limit: 200,
  });
  for (const p of payments) {
    const gw = await gatewayOf(p.gateway!);
    if (!gw) continue;
    try {
      const v = await gw.adapter.fetchStatus(p.gatewayOrderId!);
      // The payer may still be retrying inside the checkout: young failures are left to webhooks.
      const young = now.getTime() - p.createdAt.getTime() < 30 * MINUTE;
      const outcome = v.status === 'failed' && young ? 'pending' : await applyStatus(gw.cfg, v);
      if (outcome === 'posted' || outcome === 'failed') stats.payments++;
      else if (outcome === 'pending' && p.status === 'pending')
        await FeePayment.update(
          { status: 'pending' },
          { where: { instituteId, id: p.id, status: 'pending', postedAt: null } },
        );
    } catch (err) {
      fail(err, { paymentId: p.id });
    }
  }

  const refunds = await FeeRefund.findAll({
    where: { instituteId, status: 'pending', [Op.or]: dueForCheck(now, 30 * 24 * HOUR) },
    order: [['id', 'ASC']],
    limit: 200,
  });
  for (const r of refunds) {
    try {
      const p = await FeePayment.findOne({ where: { instituteId, id: r.paymentId } });
      if (!p) continue;
      const stale = now.getTime() - r.createdAt.getTime() > 5 * MINUTE;
      if (p.mode !== 'online' || !p.gateway) {
        // Offline refunds post within the request; one still pending was interrupted before posting.
        if (stale) {
          await FeeRefund.update(
            { status: 'failed', processedAt: now },
            { where: { instituteId, id: r.id, status: 'pending' } },
          );
          stats.refunds++;
        }
        continue;
      }
      const gw = await gatewayOf(p.gateway);
      if (!gw) continue;
      const ref = gatewayRefundRef(r);
      const ids = { gatewayOrderId: p.gatewayOrderId ?? '', gatewayPaymentId: p.gatewayPaymentId ?? '' };
      let result = await gw.adapter.fetchRefundStatus({
        ...ids,
        refundId: ref,
        gatewayRefundId: r.gatewayRefundId,
      });
      if (!result) {
        if (!stale) continue;
        // The request never reached the gateway: send it again under the same reference.
        try {
          result = await gw.adapter.refund({
            ...ids,
            amountPaise: r.amount,
            refundId: ref,
            note: r.reason?.slice(0, 200) || undefined,
          });
        } catch (err) {
          if (!(err instanceof GatewayRequestError) || err.retryable) throw err;
          result = {
            refundId: ref,
            gatewayRefundId: null,
            status: 'failed',
            amountPaise: r.amount,
            message: err.message,
          };
        }
      }
      const outcome = await applyRefundResult(
        gw.cfg,
        r.id,
        result,
        `refund:${result.gatewayRefundId ?? ref}:${result.status}`,
      );
      await afterRefundChanged(r.id, outcome);
      if (outcome === 'refund_processed' || outcome === 'refund_failed') stats.refunds++;
      else
        await FeeRefund.update(
          { status: 'pending' },
          { where: { instituteId, id: r.id, status: 'pending' } },
        );
    } catch (err) {
      fail(err, { refundId: r.id });
    }
  }
  return stats;
}
