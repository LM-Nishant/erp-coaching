import { Op, type Transaction, type WhereOptions } from 'sequelize';
import type {
  SaasCheckoutDto,
  SaasCreditNoteDto,
  SaasInvoiceDetailDto,
  SaasInvoiceDto,
  SaasPaymentDto,
  SaasPaymentMethod,
  SaasPaymentStatus,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import {
  createPaymentGateway,
  PAYMENT_GATEWAY_NAMES,
  WebhookSignatureError,
  type GatewayCredentials,
  type MockPaymentGateway,
  type PaymentGatewayName,
  type VerifiedPayment,
} from '../../infrastructure/payment-gateways';
import { audit } from '../../shared/audit/audit.service';
import { runWithContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, NotFound } from '../../shared/errors';
import {
  SubscriptionCreditNote,
  SubscriptionInvoice,
  SubscriptionPayment,
  SubscriptionWebhookEvent,
} from './models';
import {
  createCreditNote,
  findInvoice,
  invoiceBalance,
  platform,
  toCreditNoteDto,
  toInvoiceDto,
} from './invoices.service';
import { applyInvoicePaid } from './lifecycle.service';
import { invalidateAccess } from './subscription.service';
import { notifyInstituteAdmins } from './notifications';
import { formatRupees, withLockRetry } from './util';

// ------------------------------------------------------------------ gateway resolution

export interface SaasGatewayConfig {
  gateway: PaymentGatewayName;
  credentials: GatewayCredentials;
}

/**
 * Supplies the operator's gateway and decrypted credentials (the platform module registers it).
 * `checkout` asks for the default enabled gateway (or `gateway` if given); `verify` asks for the
 * named gateway's credentials even if it was disabled after the order was created.
 */
export type SaasGatewayResolver = (input: {
  gateway?: string;
  purpose: 'checkout' | 'verify';
}) => Promise<SaasGatewayConfig | null>;

let gatewayResolver: SaasGatewayResolver | null = null;

export function setSaasGatewayResolver(fn: SaasGatewayResolver | null): void {
  gatewayResolver = fn;
}

const notConfigured = () =>
  new AppError(503, 'GATEWAY_NOT_CONFIGURED', 'Online payment is not configured yet; please contact support');

/** Without a configured gateway the mock gateway serves development and tests (never production). */
async function resolveGateway(gateway: string | undefined, purpose: 'checkout' | 'verify') {
  const cfg = gatewayResolver ? await gatewayResolver({ gateway, purpose }) : null;
  if (cfg) return cfg;
  if ((gateway ?? 'mock') === 'mock' && !config.isProd)
    return { gateway: 'mock', credentials: {} } satisfies SaasGatewayConfig;
  throw notConfigured();
}

// ------------------------------------------------------------------ DTOs and listing

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toPaymentDto(
  p: SubscriptionPayment,
  invoice?: Pick<SubscriptionInvoice, 'number' | 'billedTo'> | null,
): SaasPaymentDto {
  const inv = invoice ?? p.invoice ?? null;
  return {
    id: p.id,
    instituteId: p.instituteId,
    instituteName: inv?.billedTo?.name ?? '',
    invoiceId: p.invoiceId,
    invoiceNumber: inv?.number ?? null,
    amountPaise: p.amountPaise,
    method: p.method,
    gateway: p.gateway,
    gatewayOrderId: p.gatewayOrderId,
    gatewayPaymentId: p.gatewayPaymentId,
    status: p.status,
    reference: p.reference,
    note: p.note,
    paidAt: iso(p.paidAt),
    createdAt: p.createdAt.toISOString(),
  };
}

const invoiceInclude = {
  model: SubscriptionInvoice,
  as: 'invoice',
  attributes: ['id', 'number', 'billedTo'],
};

export interface PaymentListQuery {
  instituteId?: number;
  invoiceId?: number;
  status?: SaasPaymentStatus;
  method?: SaasPaymentMethod;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

/** Tenant routes pass their institute id (`tenantScoped`); the super admin may list everything. */
export async function listPayments(q: PaymentListQuery, tenantScoped: boolean) {
  const where: Record<string | symbol, unknown> = {};
  if (q.instituteId) where.instituteId = q.instituteId;
  if (q.invoiceId) where.invoiceId = q.invoiceId;
  if (q.status) where.status = q.status;
  if (q.method) where.method = q.method;
  if (q.from || q.to)
    where.createdAt = {
      ...(q.from ? { [Op.gte]: new Date(`${q.from}T00:00:00Z`) } : {}),
      ...(q.to ? { [Op.lt]: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) } : {}),
    };
  const opts = {
    where: where as WhereOptions,
    include: [invoiceInclude],
    order: [['id', 'DESC']] as [string, string][],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  };
  const { rows, count } = await SubscriptionPayment.findAndCountAll(tenantScoped ? opts : platform(opts));
  return { items: rows.map((p) => toPaymentDto(p)), total: count, page: q.page, pageSize: q.pageSize };
}

/** Invoice with its payments and credit notes (`instituteId` null: super admin). */
export async function invoiceDetail(id: number, instituteId: number | null): Promise<SaasInvoiceDetailDto> {
  const inv = await findInvoice(id, instituteId);
  const scoped = <T extends { where: object }>(opts: T): T =>
    instituteId === null ? platform(opts) : { ...opts, where: { ...opts.where, instituteId } };
  const order = [['id', 'DESC']] as [string, string][];
  const [payments, notes] = await Promise.all([
    SubscriptionPayment.findAll(scoped({ where: { invoiceId: inv.id }, order })),
    SubscriptionCreditNote.findAll(scoped({ where: { invoiceId: inv.id }, order })),
  ]);
  return {
    invoice: toInvoiceDto(inv),
    payments: payments.map((p) => toPaymentDto(p, inv)),
    creditNotes: notes.map((n) => toCreditNoteDto(n, inv.number)),
  };
}

async function loadPayment(id: number, instituteId: number | null) {
  const opts = { where: instituteId === null ? { id } : { instituteId, id }, include: [invoiceInclude] };
  const p = await SubscriptionPayment.findOne(instituteId === null ? platform(opts) : opts);
  if (!p) throw NotFound('Payment');
  return p;
}

// ------------------------------------------------------------------ settlement

/**
 * Adds a successful payment to its invoice (locked by the caller). Settling the balance marks the
 * invoice paid and applies what it bought. Money is never refused: a payment against a void or
 * already settled invoice is kept and flagged for a manual refund or adjustment.
 */
async function applyToInvoice(
  inv: SubscriptionInvoice,
  p: SubscriptionPayment,
  transaction: Transaction,
  now: Date,
): Promise<boolean> {
  if (inv.status === 'void') {
    await p.update({ note: 'Received against a void invoice: refund or adjust manually' }, { transaction });
    logger.warn({ paymentId: p.id, invoiceId: inv.id }, 'SaaS payment received against a void invoice');
    return false;
  }
  const wasOpen = inv.status === 'open';
  const paidPaise = inv.paidPaise + p.amountPaise;
  const settled = wasOpen && inv.totalPaise - inv.creditedPaise - paidPaise <= 0;
  await inv.update(
    { paidPaise, ...(settled ? { status: 'paid' as const, paidAt: now } : {}) },
    { transaction },
  );
  if (!wasOpen)
    await p.update(
      { note: 'Received after the invoice was settled: refund or adjust the excess' },
      { transaction },
    );
  if (settled) await applyInvoicePaid(inv, transaction, now);
  return settled;
}

export type SaasWebhookOutcome =
  'paid' | 'failed' | 'duplicate' | 'already_processed' | 'unmatched' | 'amount_mismatch' | 'pending';

interface AppliedResult {
  outcome: SaasWebhookOutcome;
  paymentId: number | null;
}

/**
 * Applies a verified gateway status once: the (gateway, event key) row is inserted in the same
 * transaction, so a replayed event hits the unique index; the payment row is locked and its status
 * checked, so a different event for an already processed payment is a no-op.
 */
async function applyVerified(
  gateway: string,
  v: VerifiedPayment,
  eventKey: string,
  now = new Date(),
): Promise<AppliedResult> {
  const key = eventKey.slice(0, 191);
  const pre = await SubscriptionPayment.findOne(
    platform({ where: { gateway, gatewayOrderId: v.gatewayOrderId }, attributes: ['id'] }),
  );
  let outcome: SaasWebhookOutcome = 'pending';
  try {
    await withLockRetry(() =>
      getSequelize().transaction(async (transaction) => {
        outcome = 'pending';
        const event = await SubscriptionWebhookEvent.create(
          { gateway, eventKey: key, paymentId: pre?.id ?? null, outcome: 'received' },
          { transaction },
        );
        const p = pre
          ? await SubscriptionPayment.findOne(
              platform({ where: { id: pre.id }, transaction, lock: transaction.LOCK.UPDATE }),
            )
          : null;
        if (!p) outcome = 'unmatched';
        else if (v.status === 'success') {
          if (p.status === 'success') outcome = 'already_processed';
          else if (v.amountPaise !== p.amountPaise) {
            outcome = 'amount_mismatch';
            logger.error(
              { paymentId: p.id, expected: p.amountPaise, got: v.amountPaise },
              'SaaS gateway amount mismatch',
            );
          } else {
            await p.update(
              {
                status: 'success',
                gatewayPaymentId: v.gatewayPaymentId || p.gatewayPaymentId,
                feePaise: v.feePaise ?? 0,
                paidAt: now,
              },
              { transaction },
            );
            if (p.invoiceId)
              await applyToInvoice(
                await findInvoice(p.invoiceId, null, { transaction, lock: true }),
                p,
                transaction,
                now,
              );
            outcome = 'paid';
          }
        } else if (v.status === 'failed') {
          if (p.status === 'pending') {
            await p.update(
              { status: 'failed', gatewayPaymentId: v.gatewayPaymentId || null },
              { transaction },
            );
            outcome = 'failed';
          } else outcome = 'already_processed';
        }
        await event.update({ outcome }, { transaction });
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      const dup = await SubscriptionWebhookEvent.findOne({ where: { gateway, eventKey: key } });
      if (dup) return { outcome: 'duplicate', paymentId: dup.paymentId };
    }
    throw err;
  }
  // Assigned inside the transaction callback, which the compiler's narrowing does not see.
  const final = outcome as SaasWebhookOutcome;
  if (pre && (final === 'paid' || final === 'failed')) await afterGatewayPayment(pre.id, final);
  return { outcome: final, paymentId: pre?.id ?? null };
}

async function afterGatewayPayment(paymentId: number, outcome: 'paid' | 'failed') {
  const p = await loadPayment(paymentId, null);
  if (!p.instituteId) return;
  invalidateAccess(p.instituteId);
  const data = { invoiceNo: p.invoice?.number ?? '', amount: formatRupees(p.amountPaise) };
  await runWithContext({ system: true, instituteId: p.instituteId, allowedBranchIds: null }, () =>
    audit({
      action: outcome === 'paid' ? 'subscription.payment_received' : 'subscription.payment_failed',
      entityType: 'subscription_payment',
      entityId: p.id,
      instituteId: p.instituteId,
      metadata: { invoiceId: p.invoiceId, amountPaise: p.amountPaise, gateway: p.gateway },
    }),
  );
  await notifyInstituteAdmins(
    p.instituteId,
    outcome === 'paid' ? 'subscriptions.payment-received' : 'subscriptions.payment-failed',
    data,
  );
}

// ------------------------------------------------------------------ checkout and webhooks

function replay(p: SubscriptionPayment, inv: SubscriptionInvoice): SaasCheckoutDto {
  if (p.invoiceId !== inv.id)
    throw Conflict('The idempotency key was already used for another invoice', 'IDEMPOTENCY_KEY_REUSED');
  if (p.status === 'failed' && !p.checkoutPayload)
    throw new AppError(502, 'GATEWAY_ERROR', 'The payment gateway is unavailable; please try again');
  return {
    invoice: toInvoiceDto(inv),
    payment: toPaymentDto(p, inv),
    gateway: p.gateway ?? 'mock',
    checkout: p.checkoutPayload ?? {},
  };
}

const RECENT_CHECKOUT_MS = 30 * 60_000;

/**
 * Starts (or resumes) an online payment of an open invoice's balance. Retries with the same
 * idempotency key, and repeated clicks within 30 minutes, return the same gateway order.
 */
export async function startCheckout(
  instituteId: number,
  invoiceId: number,
  opts: {
    idempotencyKey?: string | null;
    userId: number | null;
    customer: { name: string; mobile: string; email?: string };
  },
): Promise<SaasCheckoutDto> {
  const inv = await findInvoice(invoiceId, instituteId);
  const key = opts.idempotencyKey ? `${instituteId}:${opts.idempotencyKey}`.slice(0, 160) : null;
  if (key) {
    const existing = await SubscriptionPayment.findOne({ where: { instituteId, idempotencyKey: key } });
    if (existing) return replay(existing, inv);
  }
  if (inv.status !== 'open')
    throw Conflict(
      inv.status === 'paid' ? 'The invoice is already paid' : 'The invoice is void',
      'INVOICE_NOT_OPEN',
    );
  const amount = invoiceBalance(inv);
  if (amount <= 0) throw Conflict('Nothing is due on this invoice', 'INVOICE_NOT_OPEN');
  const cfg = await resolveGateway(undefined, 'checkout');
  const recent = await SubscriptionPayment.findOne({
    where: {
      instituteId,
      invoiceId: inv.id,
      method: 'gateway',
      gateway: cfg.gateway,
      status: 'pending',
      amountPaise: amount,
      createdAt: { [Op.gte]: new Date(Date.now() - RECENT_CHECKOUT_MS) },
    },
    order: [['id', 'DESC']],
  });
  if (recent?.checkoutPayload) return replay(recent, inv);

  let payment: SubscriptionPayment;
  try {
    payment = await SubscriptionPayment.create({
      instituteId,
      invoiceId: inv.id,
      amountPaise: amount,
      method: 'gateway',
      gateway: cfg.gateway,
      gatewayOrderId: null,
      status: 'pending',
      reference: null,
      note: null,
      idempotencyKey: key,
      recordedBy: opts.userId,
    });
  } catch (err) {
    if (key && (err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      const existing = await SubscriptionPayment.findOne({ where: { instituteId, idempotencyKey: key } });
      if (existing) return replay(existing, inv);
    }
    throw err;
  }
  try {
    const order = await createPaymentGateway(cfg.gateway, cfg.credentials).createOrder({
      orderId: `saas_${payment.id}`,
      amountPaise: amount,
      currency: 'INR',
      customer: opts.customer,
      callbackUrl: `/subscription?invoice=${inv.id}`,
      metadata: { invoiceNumber: inv.number, instituteId: String(instituteId) },
    });
    await payment.update({ gatewayOrderId: order.gatewayOrderId, checkoutPayload: order.checkout });
  } catch (err) {
    logger.error({ err, paymentId: payment.id }, 'SaaS checkout order could not be created');
    await payment.update({ status: 'failed', note: 'The gateway order could not be created' });
    throw new AppError(502, 'GATEWAY_ERROR', 'The payment gateway is unavailable; please try again');
  }
  return {
    invoice: toInvoiceDto(inv),
    payment: toPaymentDto(payment, inv),
    gateway: cfg.gateway,
    checkout: payment.checkoutPayload ?? {},
  };
}

/** Public webhook: the signature is verified with the operator's credentials before anything is trusted. */
export async function processWebhook(
  gatewayName: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<AppliedResult> {
  if (!(PAYMENT_GATEWAY_NAMES as readonly string[]).includes(gatewayName)) throw NotFound('Webhook');
  let cfg: SaasGatewayConfig;
  try {
    cfg = await resolveGateway(gatewayName, 'verify');
  } catch {
    throw NotFound('Webhook');
  }
  let verified: VerifiedPayment;
  try {
    verified = await createPaymentGateway(cfg.gateway, cfg.credentials).verifyWebhook(headers, rawBody);
  } catch (err) {
    if (err instanceof WebhookSignatureError)
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
    throw new AppError(400, 'INVALID_WEBHOOK', (err as Error).message);
  }
  const eventKey =
    verified.eventId ?? `${verified.gatewayPaymentId || verified.gatewayOrderId}:${verified.status}`;
  return applyVerified(cfg.gateway, verified, eventKey);
}

/** Development/test only: simulates the mock gateway's hosted checkout and delivers its webhook. */
export async function completeMockCheckout(
  instituteId: number,
  paymentId: number,
  outcome: 'success' | 'failed',
) {
  if (config.isProd) throw NotFound('Payment');
  const p = await loadPayment(paymentId, instituteId);
  if (p.gateway !== 'mock' || !p.gatewayOrderId) throw BadRequest('Not a mock gateway payment');
  const cfg = await resolveGateway('mock', 'verify');
  const gateway = createPaymentGateway('mock', cfg.credentials) as MockPaymentGateway;
  const { body, headers } = gateway.completeCheckout(p.gatewayOrderId, outcome, p.amountPaise);
  const result = await processWebhook('mock', Buffer.from(body), headers);
  return { outcome: result.outcome, payment: toPaymentDto(await loadPayment(paymentId, instituteId)) };
}

/** Server-side status check, for a missed webhook (`instituteId` null: super admin). */
export async function syncPayment(instituteId: number | null, paymentId: number) {
  const p = await loadPayment(paymentId, instituteId);
  if (p.method !== 'gateway' || !p.gateway || !p.gatewayOrderId) throw BadRequest('Not an online payment');
  const cfg = await resolveGateway(p.gateway, 'verify');
  const v = await createPaymentGateway(cfg.gateway, cfg.credentials).fetchStatus(p.gatewayOrderId);
  const outcome =
    v.status === 'pending'
      ? 'pending'
      : (await applyVerified(cfg.gateway, v, `status:${v.gatewayPaymentId || v.gatewayOrderId}:${v.status}`))
          .outcome;
  return { outcome, payment: toPaymentDto(await loadPayment(paymentId, instituteId)) };
}

// ------------------------------------------------------------------ super admin adjustments

export interface ManualPaymentInput {
  amountPaise: number;
  reference?: string | null;
  note?: string | null;
  paidAt?: Date | null;
}

/** Records an offline payment (bank transfer, cheque) against an open invoice. */
export async function recordManualPayment(
  invoiceId: number,
  input: ManualPaymentInput,
  userId: number | null,
  now = new Date(),
): Promise<{ payment: SaasPaymentDto; invoice: SaasInvoiceDto }> {
  const { payment, invoice } = await withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      const inv = await findInvoice(invoiceId, null, { transaction, lock: true });
      if (inv.status !== 'open') throw Conflict('Only open invoices can take payments', 'INVOICE_NOT_OPEN');
      const balance = invoiceBalance(inv);
      if (input.amountPaise <= 0 || input.amountPaise > balance)
        throw BadRequest(`The amount must be between 0.01 and ${formatRupees(balance)}`);
      const p = await SubscriptionPayment.create(
        {
          instituteId: inv.instituteId,
          invoiceId: inv.id,
          amountPaise: input.amountPaise,
          method: 'manual',
          gateway: null,
          gatewayOrderId: null,
          status: 'success',
          reference: input.reference ?? null,
          note: input.note ?? null,
          idempotencyKey: null,
          paidAt: input.paidAt ?? now,
          recordedBy: userId,
        },
        { transaction },
      );
      await applyToInvoice(inv, p, transaction, now);
      return { payment: p, invoice: inv };
    }),
  );
  if (invoice.instituteId) {
    invalidateAccess(invoice.instituteId);
    await notifyInstituteAdmins(invoice.instituteId, 'subscriptions.payment-received', {
      invoiceNo: invoice.number,
      amount: formatRupees(payment.amountPaise),
    });
  }
  return { payment: toPaymentDto(payment, invoice), invoice: toInvoiceDto(invoice) };
}

/** Credit note against an invoice; one that settles an open invoice applies what it bought. */
export async function creditInvoice(
  invoiceId: number,
  amountPaise: number,
  reason: string,
  userId: number | null,
  now = new Date(),
): Promise<{ creditNote: SaasCreditNoteDto; invoice: SaasInvoiceDto }> {
  const { note, invoice } = await withLockRetry(() =>
    getSequelize().transaction(async (transaction) => {
      const r = await createCreditNote(invoiceId, amountPaise, reason, userId, transaction);
      if (r.settled) await applyInvoicePaid(r.invoice, transaction, now);
      return r;
    }),
  );
  if (invoice.instituteId) invalidateAccess(invoice.instituteId);
  return { creditNote: toCreditNoteDto(note, invoice.number), invoice: toInvoiceDto(invoice) };
}
