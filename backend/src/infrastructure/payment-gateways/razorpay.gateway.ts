import crypto from 'node:crypto';
import { gatewayRequest, header, parseJson, safeEqual, vendorText } from './http';
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

const API = 'https://api.razorpay.com/v1';

interface RzpError {
  error?: { code?: string; description?: string };
}

interface RzpOrder {
  id: string;
  amount: number;
  currency: string;
}

interface RzpPayment {
  id: string;
  order_id?: string | null;
  amount?: number;
  status?: string;
  method?: string;
  fee?: number | null;
  error_description?: string | null;
  acquirer_data?: Record<string, string | null | undefined>;
  created_at?: number;
}

interface RzpRefund {
  id: string;
  payment_id?: string;
  amount?: number;
  status?: string;
  receipt?: string | null;
  notes?: Record<string, string> | unknown[];
}

const paymentStatus = (s: string | undefined): GatewayPaymentStatus =>
  s === 'captured' || s === 'refunded' ? 'success' : s === 'failed' ? 'failed' : 'pending';

const refundReference = (r: RzpRefund) => r.receipt || (!Array.isArray(r.notes) && r.notes?.reference) || '';

/**
 * Razorpay Standard Checkout: Orders API + checkout.js, Basic auth with the key ID and secret.
 * Test and live mode are chosen by the key (rzp_test_ / rzp_live_), so the mode setting must match it.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;

  constructor(private readonly creds: GatewayCredentials) {}

  private keyId(): string {
    const id = this.creds.merchantId?.trim();
    if (!id || !this.creds.secretKey) throw new GatewayConfigError('Razorpay needs a key ID and key secret');
    if (this.creds.sandbox === false && id.startsWith('rzp_test_'))
      throw new GatewayConfigError(
        'This is a Razorpay test key (rzp_test_…): use a live key or turn on test mode',
      );
    if (this.creds.sandbox === true && id.startsWith('rzp_live_'))
      throw new GatewayConfigError(
        'This is a Razorpay live key (rzp_live_…): use a test key or turn off test mode',
      );
    return id;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    const auth = Buffer.from(`${this.keyId()}:${this.creds.secretKey}`).toString('base64');
    const res = await gatewayRequest('razorpay', {
      method,
      url: `${API}${path}`,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ok = res.status >= 200 && res.status < 300 && res.json != null;
    return { ok, status: res.status, data: res.json as T & RzpError };
  }

  private fail(status: number, data: RzpError | null): never {
    if (status === 401)
      throw new GatewayRequestError('razorpay', 'Razorpay rejected the key ID or key secret', {
        status,
        code: 'auth',
      });
    throw new GatewayRequestError(
      'razorpay',
      `Razorpay: ${vendorText(data?.error?.description, `request failed (HTTP ${status})`)}`,
      { status, code: data?.error?.code },
    );
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.call<T>('GET', path);
    if (!res.ok) this.fail(res.status, res.data);
    return res.data;
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const notes: Record<string, string> = { reference: input.orderId.slice(0, 250) };
    for (const [k, v] of Object.entries(input.metadata ?? {}).slice(0, 10))
      notes[k.slice(0, 40)] = v.slice(0, 250);
    const res = await this.call<RzpOrder>('POST', '/orders', {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.orderId.slice(0, 40),
      notes,
    });
    if (!res.ok || !res.data.id) this.fail(res.status, res.data);
    return {
      gatewayOrderId: res.data.id,
      checkout: {
        provider: 'razorpay',
        key: this.keyId(),
        orderId: res.data.id,
        amount: res.data.amount,
        currency: res.data.currency,
        description: input.description ?? null,
        prefill: {
          name: input.customer.name,
          contact: input.customer.mobile,
          email: input.customer.email ?? '',
        },
        callbackUrl: input.callbackUrl,
      },
    };
  }

  private verified(
    orderId: string,
    p: RzpPayment,
    status: GatewayPaymentStatus,
    eventId?: string,
    raw: unknown = p,
  ): VerifiedPayment {
    const acq = p.acquirer_data ?? {};
    return {
      gatewayOrderId: orderId,
      gatewayPaymentId: p.id,
      status,
      amountPaise: Number(p.amount ?? 0),
      feePaise: status === 'success' && p.fee != null ? Number(p.fee) : undefined,
      method: p.method,
      bankReference: acq.rrn || acq.upi_transaction_id || acq.bank_transaction_id || undefined,
      message: status === 'failed' ? (p.error_description ?? undefined) : undefined,
      eventId,
      raw,
    };
  }

  /** An order can have several attempts: any captured one wins, an open one keeps it pending. */
  async fetchStatus(gatewayOrderId: string): Promise<VerifiedPayment> {
    const list = await this.get<{ items?: RzpPayment[] }>(
      `/orders/${encodeURIComponent(gatewayOrderId)}/payments`,
    );
    const items = list.items ?? [];
    const paid = items.find((p) => paymentStatus(p.status) === 'success');
    const open = items.find((p) => paymentStatus(p.status) === 'pending');
    const latest = [...items].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
    const pick = paid ?? open ?? latest;
    if (!pick)
      return { gatewayOrderId, gatewayPaymentId: '', status: 'pending', amountPaise: 0, raw: { items: [] } };
    return this.verified(gatewayOrderId, pick, paid ? 'success' : open ? 'pending' : 'failed');
  }

  private refundResult(r: RzpRefund, refundId: string): RefundResult {
    return {
      refundId: refundReference(r) || refundId,
      gatewayRefundId: r.id,
      status: r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'pending',
      amountPaise: Number(r.amount ?? 0),
      raw: r,
    };
  }

  private async findRefund(gatewayPaymentId: string, refundId: string): Promise<RefundResult | null> {
    const list = await this.get<{ items?: RzpRefund[] }>(
      `/payments/${encodeURIComponent(gatewayPaymentId)}/refunds?count=100`,
    );
    const hit = (list.items ?? []).find((r) => refundReference(r) === refundId);
    return hit ? this.refundResult(hit, refundId) : null;
  }

  /** Razorpay has no refund idempotency key: an existing refund with our receipt is returned instead. */
  async refund(input: RefundInput): Promise<RefundResult> {
    const existing = await this.findRefund(input.gatewayPaymentId, input.refundId);
    if (existing) return existing;
    const res = await this.call<RzpRefund>(
      'POST',
      `/payments/${encodeURIComponent(input.gatewayPaymentId)}/refund`,
      {
        amount: input.amountPaise,
        speed: 'normal',
        receipt: input.refundId,
        notes: { reference: input.refundId, ...(input.note ? { note: input.note.slice(0, 250) } : {}) },
      },
    );
    if (res.ok && res.data.id) return this.refundResult(res.data, input.refundId);
    if (res.status === 400 || res.status === 404)
      return {
        refundId: input.refundId,
        gatewayRefundId: null,
        status: 'failed',
        amountPaise: input.amountPaise,
        message: vendorText(res.data?.error?.description, 'Razorpay rejected the refund'),
        raw: res.data,
      };
    this.fail(res.status, res.data);
  }

  async fetchRefundStatus(lookup: RefundLookup): Promise<RefundResult | null> {
    if (lookup.gatewayRefundId) {
      const res = await this.call<RzpRefund>('GET', `/refunds/${encodeURIComponent(lookup.gatewayRefundId)}`);
      if (res.ok && res.data.id) return this.refundResult(res.data, lookup.refundId);
      if (res.status !== 400 && res.status !== 404) this.fail(res.status, res.data);
    }
    return this.findRefund(lookup.gatewayPaymentId, lookup.refundId);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const key = this.keyId();
      await this.get('/orders?count=1');
      const mode = key.startsWith('rzp_live_')
        ? ' (live mode)'
        : key.startsWith('rzp_test_')
          ? ' (test mode)'
          : '';
      return { ok: true, message: `Connected to Razorpay${mode}` };
    } catch (err) {
      if (err instanceof GatewayConfigError || err instanceof GatewayRequestError)
        return { ok: false, message: err.message };
      throw err;
    }
  }

  /** `X-Razorpay-Signature` = hex HMAC-SHA256 of the raw body with the webhook secret set in the dashboard. */
  async verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<GatewayWebhookEvent> {
    const secret = this.creds.webhookSecret || this.creds.secretKey;
    if (!secret) throw new WebhookSignatureError('Razorpay webhook secret is not configured');
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEqual(header(headers, 'x-razorpay-signature'), expected)) throw new WebhookSignatureError();
    const body = parseJson(rawBody) as {
      event?: string;
      payload?: { payment?: { entity?: RzpPayment }; refund?: { entity?: RzpRefund } };
    } | null;
    const event = String(body?.event ?? '');
    const eventId = header(headers, 'x-razorpay-event-id') || undefined;
    if (event.startsWith('payment.') || event === 'order.paid') {
      const p = body?.payload?.payment?.entity;
      if (!p?.id || !p.order_id)
        return { kind: 'ignored', reason: `${event} without an order`, eventId, raw: body };
      return { kind: 'payment', ...this.verified(p.order_id, p, paymentStatus(p.status), eventId, body) };
    }
    if (event.startsWith('refund.')) {
      const r = body?.payload?.refund?.entity;
      if (!r?.id) return { kind: 'ignored', reason: `${event} without a refund`, eventId, raw: body };
      return {
        kind: 'refund',
        refund: { ...this.refundResult(r, ''), gatewayPaymentId: r.payment_id },
        eventId,
        raw: body,
      };
    }
    return { kind: 'ignored', reason: `Razorpay event ${event || '(none)'} is not used`, eventId, raw: body };
  }
}
