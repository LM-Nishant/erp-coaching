import crypto from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import type { CheckoutOrderDto, FeePaymentDto, OfflinePaymentMode, PaymentGatewayKey } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import {
  MockPaymentGateway,
  WebhookSignatureError,
  type VerifiedPayment,
} from '../../infrastructure/payment-gateways';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { AppError, BadRequest, Conflict, NotFound } from '../../shared/errors';
import { requireTenantContext, runWithContext } from '../../shared/context';
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
import { adapterFor, resolveGateway } from './gateways.service';
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
  }
  const referralCode = input.referralCode?.trim().toUpperCase().slice(0, 40) || null;
  const requested = input.couponCode?.trim().toUpperCase() || null;
  let couponCode: string | null = null;
  let discount = 0;
  let payable = amount;
  const payment = await getSequelize().transaction(async (transaction) => {
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
  const order = await gateway.createOrder({
    orderId: `${instituteId}-${payment.id}`,
    amountPaise: payable,
    currency: 'INR',
    customer: { name: account.student?.name ?? 'Student', mobile: account.student?.mobile ?? '' },
    callbackUrl: `/fees/me/payments/${payment.id}`,
    metadata: { instituteId: String(instituteId), paymentId: String(payment.id) },
  });
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
  'posted' | 'failed' | 'duplicate' | 'already_processed' | 'unmatched' | 'amount_mismatch' | 'pending';

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
            eventKey: eventKey.slice(0, 191),
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
          } else if (p.status === 'cancelled') {
            // Money arrived for a cancelled order: still post it (as advance if needed) — never lose funds.
            await p.update({ status: 'pending' }, { transaction });
            await postLocked(p, targets!, transaction, {
              gatewayPaymentId: v.gatewayPaymentId,
              gatewayCharge: v.feePaise,
              payload: v.raw,
            });
            outcome = 'posted';
          } else {
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
        where: { instituteId, gateway: cfg.gateway, eventKey: eventKey.slice(0, 191) },
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
  if (!cfg || !cfg.enabled) throw NotFound('Webhook');
  return runWithContext({ system: true, instituteId: cfg.instituteId, allowedBranchIds: null }, async () => {
    let verified: VerifiedPayment;
    try {
      verified = await adapterFor(cfg).verifyWebhook(headers, rawBody);
    } catch (err) {
      if (err instanceof WebhookSignatureError)
        throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
      throw new AppError(400, 'INVALID_WEBHOOK', (err as Error).message);
    }
    const eventKey =
      verified.eventId ?? `${verified.gatewayPaymentId || verified.gatewayOrderId}:${verified.status}`;
    const outcome = await applyVerified(cfg, verified, eventKey);
    const p = await FeePayment.findOne({
      where: { instituteId: cfg.instituteId, gateway: cfg.gateway, gatewayOrderId: verified.gatewayOrderId },
      attributes: ['id'],
    });
    return { outcome, paymentId: p?.id ?? null };
  });
}

/** Simulates the hosted checkout of the mock gateway and delivers its signed webhook. */
export async function completeMockCheckout(paymentId: number, outcome: 'success' | 'failed') {
  const payment = await paymentRepo.findById(paymentId);
  if (payment.gateway !== 'mock' || !payment.gatewayOrderId) throw BadRequest('Not a mock gateway payment');
  const cfg = await resolveGateway('mock');
  const gateway = adapterFor(cfg) as MockPaymentGateway;
  const { body, headers } = gateway.completeCheckout(payment.gatewayOrderId, outcome, payment.amount);
  return processWebhook('mock', cfg.webhookKey, Buffer.from(body), headers);
}

/** Server-side status check (fallback when a webhook was missed). */
export async function syncPaymentStatus(id: number) {
  const payment = await paymentRepo.findById(id);
  if (payment.mode !== 'online' || !payment.gateway || !payment.gatewayOrderId)
    throw BadRequest('Not an online payment');
  const cfg = await resolveGateway(payment.gateway);
  const v = await adapterFor(cfg).fetchStatus(payment.gatewayOrderId);
  const outcome =
    v.status === 'pending'
      ? 'pending'
      : await applyVerified(cfg, v, `status:${v.gatewayPaymentId || v.gatewayOrderId}:${v.status}`);
  return { outcome, payment: await loadPayment(id) };
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

export async function refundPayment(
  id: number,
  input: { amount?: number; reason?: string | null; reduceDues?: boolean },
  idempotencyKey: string | null,
) {
  const { instituteId, userId } = requireTenantContext();
  const payment = await paymentRepo.findById(id, { include: ['student'] });
  if (idempotencyKey) {
    const existing = await FeeRefund.findOne({ where: { instituteId, idempotencyKey } });
    if (existing) {
      if (existing.paymentId !== id) throw Conflict('Idempotency key already used', 'IDEMPOTENCY_CONFLICT');
      return { refund: existing, payment: await loadPayment(id), replay: true };
    }
  }
  if (!['successful', 'partially_refunded'].includes(payment.status))
    throw Conflict('Only successful payments can be refunded', 'NOT_REFUNDABLE');
  const refundable = payment.amount - payment.refunded;
  const amount = input.amount ?? refundable;
  if (amount <= 0 || amount > refundable)
    throw BadRequest(`Refund must be between 1 and ${refundable} paise`);
  const key = idempotencyKey ?? crypto.randomUUID();
  let refund: FeeRefund;
  try {
    refund = await FeeRefund.create({
      instituteId,
      paymentId: id,
      amount,
      reason: input.reason ?? null,
      reduceDues: input.reduceDues ?? false,
      idempotencyKey: key,
      requestedByUserId: userId ?? null,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      const existing = await FeeRefund.findOne({ where: { instituteId, idempotencyKey: key } });
      if (existing) return { refund: existing, payment: await loadPayment(id), replay: true };
    }
    throw err;
  }
  if (payment.mode === 'online' && payment.gateway) {
    try {
      const cfg = await resolveGateway(payment.gateway);
      const r = await adapterFor(cfg).refund(
        payment.gatewayPaymentId ?? '',
        amount,
        `refund-${instituteId}-${refund.id}-${key}`,
      );
      await refund.update({ gatewayRefundId: r.refundId });
      if (r.status === 'failed') {
        await refund.update({ status: 'failed' });
        throw Conflict('The gateway rejected the refund', 'GATEWAY_REFUND_FAILED');
      }
    } catch (err) {
      if (refund.status !== 'failed') await refund.update({ status: 'failed' });
      if (err instanceof AppError) throw err;
      throw new AppError(502, 'GATEWAY_REFUND_FAILED', (err as Error).message);
    }
  }
  await withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      const p = await lockPayment(id, transaction);
      if (amount > p.amount - p.refunded)
        throw Conflict('Refund exceeds the refundable amount', 'NOT_REFUNDABLE');
      await reverseLocked(
        p,
        amount,
        `refund:${refund.id}`,
        {
          reduceDues: refund.reduceDues,
          narration: `Refund${input.reason ? `: ${input.reason}` : ''}`,
          restoreCoupon: p.refunded + amount >= p.amount,
        },
        transaction,
      );
      const refunded = p.refunded + amount;
      await p.update(
        { refunded, status: refunded >= p.amount ? 'refunded' : 'partially_refunded' },
        { transaction },
      );
      if (refunded >= p.amount) await releasePaymentCoupon(p, transaction);
      await refund.update({ status: 'processed', processedAt: new Date() }, { transaction });
    }),
  );
  const after = await loadPayment(id);
  await auditFee({
    action: 'fees.payment.refund',
    entityType: 'fee_payment',
    entityId: id,
    before: { refunded: payment.refunded },
    after: { refunded: after.refunded, refundId: refund.id, amount },
  });
  if (after.student)
    await notifyStudent(
      'fees.refund',
      after.student,
      { amount: money(amount), receiptNo: after.receipt?.number ?? '-' },
      after.branchId,
    );
  return { refund, payment: after, replay: false };
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
