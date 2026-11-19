import crypto from 'node:crypto';
import {
  customerRef,
  gatewayRequest,
  header,
  looksLikeEmail,
  paise,
  parseJson,
  rupees,
  safeEqual,
  tenDigitMobile,
  vendorOrderId,
  vendorText,
} from './http';
import {
  GatewayConfigError,
  GatewayRequestError,
  WebhookSignatureError,
  type ConnectionTestResult,
  type CreateOrderInput,
  type GatewayCredentials,
  type GatewayOrder,
  type GatewayPaymentStatus,
  type GatewayWebhookEvent,
  type PaymentGateway,
  type RefundInput,
  type RefundLookup,
  type RefundResult,
  type VerifiedPayment,
} from './types';

const HOSTS = { sandbox: 'https://sandbox.cashfree.com/pg', production: 'https://api.cashfree.com/pg' };
export const CASHFREE_API_VERSION = '2026-01-01';

interface CfError {
  message?: string;
  code?: string;
  type?: string;
}

interface CfPayment {
  cf_payment_id?: string | number;
  order_id?: string;
  payment_status?: string;
  payment_amount?: number | string;
  payment_message?: string | null;
  payment_time?: string | null;
  payment_completion_time?: string | null;
  bank_reference?: string | null;
  payment_group?: string | null;
  payment_method?: Record<string, unknown> & { payment_status?: string };
}

interface CfRefund {
  cf_refund_id?: string | number;
  refund_id?: string;
  order_id?: string;
  cf_payment_id?: string | number;
  refund_amount?: number | string;
  refund_status?: string;
  status_description?: string | null;
}

// The API reference nests `payment_status` under `payment_method` in one example: accept both.
const statusOf = (p: CfPayment) =>
  String(p.payment_status ?? p.payment_method?.payment_status ?? '').toUpperCase();

function paymentStatus(s: string): GatewayPaymentStatus {
  if (s === 'SUCCESS') return 'success';
  if (s === 'PENDING' || s === 'NOT_ATTEMPTED' || s === '') return 'pending';
  return 'failed'; // FAILED, USER_DROPPED, CANCELLED, VOID
}

function refundStatus(s: string | undefined): RefundResult['status'] {
  const v = String(s ?? '').toUpperCase();
  if (v === 'SUCCESS') return 'processed';
  if (v === 'CANCELLED' || v === 'REJECTED' || v === 'FAILED') return 'failed';
  return 'pending'; // PENDING, ONHOLD
}

const https = (url: string | undefined) => (url && /^https:\/\//i.test(url) ? url : undefined);

/** Cashfree Payment Gateway (PG API, client ID + secret headers) with the JS SDK v3 checkout. */
export class CashfreeGateway implements PaymentGateway {
  readonly name = 'cashfree' as const;

  constructor(private readonly creds: GatewayCredentials) {}

  private get production() {
    return this.creds.sandbox === false;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    const id = this.creds.merchantId?.trim();
    const secret = this.creds.secretKey;
    if (!id || !secret) throw new GatewayConfigError('Cashfree needs a client ID (app ID) and client secret');
    return {
      'x-client-id': id,
      'x-client-secret': secret,
      'x-api-version': CASHFREE_API_VERSION,
      'x-request-id': crypto.randomUUID(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
    };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string) {
    const res = await gatewayRequest('cashfree', {
      method,
      url: `${this.production ? HOSTS.production : HOSTS.sandbox}${path}`,
      headers: this.headers(idempotencyKey),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ok = res.status >= 200 && res.status < 300 && res.json != null;
    return { ok, status: res.status, data: res.json as T & CfError };
  }

  private fail(status: number, data: CfError | null): never {
    if (status === 401)
      throw new GatewayRequestError('cashfree', 'Cashfree rejected the client ID or client secret', {
        status,
        code: 'auth',
      });
    throw new GatewayRequestError(
      'cashfree',
      `Cashfree: ${vendorText(data?.message, `request failed (HTTP ${status})`)}`,
      { status, code: data?.code },
    );
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const orderId = vendorOrderId(input.orderId, 45, /[A-Za-z0-9_-]/);
    const meta = { return_url: https(input.callbackUrl), notify_url: https(input.notifyUrl) };
    const res = await this.call<{ order_id?: string; payment_session_id?: string }>('POST', '/orders', {
      order_id: orderId,
      order_amount: Number(rupees(input.amountPaise)),
      order_currency: input.currency,
      customer_details: {
        customer_id: customerRef(input.customer.id, input.customer.mobile),
        customer_phone: tenDigitMobile(input.customer.mobile),
        customer_name: input.customer.name.slice(0, 100) || undefined,
        customer_email: looksLikeEmail(input.customer.email) ? input.customer.email : undefined,
      },
      order_meta: meta.return_url || meta.notify_url ? meta : undefined,
      order_note: input.description?.slice(0, 200) || undefined,
      order_tags: { reference: input.orderId.slice(0, 200) },
    });
    if (!res.ok || !res.data.payment_session_id) this.fail(res.status, res.data);
    return {
      gatewayOrderId: res.data.order_id ?? orderId,
      checkout: {
        provider: 'cashfree',
        mode: this.production ? 'production' : 'sandbox',
        paymentSessionId: res.data.payment_session_id,
        orderId: res.data.order_id ?? orderId,
      },
    };
  }

  private verified(
    orderId: string,
    p: CfPayment,
    status: GatewayPaymentStatus,
    raw: unknown = p,
  ): VerifiedPayment {
    return {
      gatewayOrderId: orderId,
      gatewayPaymentId: p.cf_payment_id != null ? String(p.cf_payment_id) : '',
      status,
      amountPaise: paise(p.payment_amount),
      method: p.payment_group ?? undefined,
      bankReference: p.bank_reference ?? undefined,
      message: status === 'failed' ? (p.payment_message ?? undefined) : undefined,
      raw,
    };
  }

  /** Any successful attempt wins; a pending one keeps the order pending; otherwise the latest failure. */
  async fetchStatus(gatewayOrderId: string): Promise<VerifiedPayment> {
    const res = await this.call<CfPayment[]>('GET', `/orders/${encodeURIComponent(gatewayOrderId)}/payments`);
    if (!res.ok || !Array.isArray(res.data)) this.fail(res.status, res.data);
    const items = res.data;
    const time = (p: CfPayment) => Date.parse(p.payment_completion_time ?? p.payment_time ?? '') || 0;
    const paid = items.find((p) => paymentStatus(statusOf(p)) === 'success');
    const open = items.find((p) => paymentStatus(statusOf(p)) === 'pending');
    const latest = [...items].sort((a, b) => time(b) - time(a))[0];
    const pick = paid ?? open ?? latest;
    if (!pick) return { gatewayOrderId, gatewayPaymentId: '', status: 'pending', amountPaise: 0, raw: [] };
    return this.verified(gatewayOrderId, pick, paid ? 'success' : open ? 'pending' : 'failed');
  }

  private refundResult(r: CfRefund, refundId: string): RefundResult {
    return {
      refundId: r.refund_id || refundId,
      gatewayRefundId: r.cf_refund_id != null ? String(r.cf_refund_id) : null,
      status: refundStatus(r.refund_status),
      amountPaise: paise(r.refund_amount),
      message: r.status_description ?? undefined,
      raw: r,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const note = (input.note ?? '')
      .replace(/[^\w .,/-]/g, '')
      .trim()
      .slice(0, 100);
    const res = await this.call<CfRefund>(
      'POST',
      `/orders/${encodeURIComponent(input.gatewayOrderId)}/refunds`,
      {
        refund_amount: Number(rupees(input.amountPaise)),
        refund_id: input.refundId,
        refund_note: note.length >= 3 ? note : 'Refund',
        refund_speed: 'STANDARD',
      },
      input.refundId,
    );
    if (res.ok) return this.refundResult(res.data, input.refundId);
    if (res.status === 409) {
      const existing = await this.fetchRefundStatus(input);
      if (existing) return existing;
    }
    if (res.status === 400 || res.status === 404 || res.status === 409 || res.status === 422)
      return {
        refundId: input.refundId,
        gatewayRefundId: null,
        status: 'failed',
        amountPaise: input.amountPaise,
        message: vendorText(res.data?.message, 'Cashfree rejected the refund'),
        raw: res.data,
      };
    this.fail(res.status, res.data);
  }

  async fetchRefundStatus(lookup: RefundLookup): Promise<RefundResult | null> {
    const res = await this.call<CfRefund>(
      'GET',
      `/orders/${encodeURIComponent(lookup.gatewayOrderId)}/refunds/${encodeURIComponent(lookup.refundId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) this.fail(res.status, res.data);
    return this.refundResult(res.data, lookup.refundId);
  }

  /** Looks up an order that cannot exist: "not found" proves the keys work without creating anything. */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const res = await this.call('GET', `/orders/conn_test_${crypto.randomBytes(6).toString('hex')}`);
      if (res.status !== 404 && !res.ok) this.fail(res.status, res.data);
      return { ok: true, message: `Connected to Cashfree (${this.production ? 'production' : 'sandbox'})` };
    } catch (err) {
      if (err instanceof GatewayConfigError || err instanceof GatewayRequestError)
        return { ok: false, message: err.message };
      throw err;
    }
  }

  /** `x-webhook-signature` = base64 HMAC-SHA256(`x-webhook-timestamp` + raw body) with the client secret. */
  async verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<GatewayWebhookEvent> {
    const secret = this.creds.secretKey;
    if (!secret) throw new WebhookSignatureError('Cashfree client secret is not configured');
    const ts = header(headers, 'x-webhook-timestamp');
    const expected = crypto
      .createHmac('sha256', secret)
      .update(ts + rawBody.toString('utf8'))
      .digest('base64');
    if (!ts || !safeEqual(header(headers, 'x-webhook-signature'), expected))
      throw new WebhookSignatureError();
    const body = parseJson(rawBody) as {
      type?: string;
      data?: { order?: { order_id?: string }; payment?: CfPayment; refund?: CfRefund };
    } | null;
    const type = String(body?.type ?? '');
    const eventId = header(headers, 'x-idempotency-key') || undefined;
    const orderId = body?.data?.order?.order_id;
    if (/^PAYMENT_(SUCCESS|FAILED|USER_DROPPED)_WEBHOOK$/.test(type) && orderId && body?.data?.payment)
      return {
        kind: 'payment',
        ...this.verified(orderId, body.data.payment, paymentStatus(statusOf(body.data.payment)), body),
        eventId,
      };
    if (type === 'REFUND_STATUS_WEBHOOK' && body?.data?.refund) {
      const r = body.data.refund;
      return {
        kind: 'refund',
        refund: {
          ...this.refundResult(r, ''),
          gatewayOrderId: r.order_id,
          gatewayPaymentId: r.cf_payment_id != null ? String(r.cf_payment_id) : undefined,
        },
        eventId,
        raw: body,
      };
    }
    return { kind: 'ignored', reason: `Cashfree event ${type || '(none)'} is not used`, eventId, raw: body };
  }
}
