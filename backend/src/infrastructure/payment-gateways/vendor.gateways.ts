import crypto from 'node:crypto';
import {
  GatewayNotAvailableError,
  WebhookSignatureError,
  type CreateOrderInput,
  type GatewayCredentials,
  type GatewayOrder,
  type PaymentGateway,
  type PaymentGatewayName,
  type VerifiedPayment,
} from './types';

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : (v ?? '');
};

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Base for real vendors. Webhook signature verification is implemented (pure crypto); the
 * vendor HTTP APIs (order creation, status, refunds) are not wired yet and fail loudly so a
 * misconfigured institute never silently "succeeds".
 */
abstract class VendorGateway implements PaymentGateway {
  abstract readonly name: PaymentGatewayName;
  constructor(protected readonly creds: GatewayCredentials) {}

  protected unavailable(op: string): never {
    throw new GatewayNotAvailableError(
      `${this.name}: ${op} is not available in this build (vendor API pending)`,
    );
  }
  protected get webhookSecret() {
    const s = this.creds.webhookSecret || this.creds.secretKey;
    if (!s) throw new WebhookSignatureError(`${this.name}: webhook secret not configured`);
    return s;
  }

  async createOrder(_input: CreateOrderInput): Promise<GatewayOrder> {
    return this.unavailable('createOrder');
  }
  async fetchStatus(_gatewayOrderId: string): Promise<VerifiedPayment> {
    return this.unavailable('fetchStatus');
  }
  async refund(
    _id: string,
    _amountPaise: number,
    _key: string,
  ): Promise<{ refundId: string; status: 'processed' | 'pending' | 'failed' }> {
    return this.unavailable('refund');
  }
  abstract verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<VerifiedPayment>;
}

/** Razorpay: `X-Razorpay-Signature` = hex HMAC-SHA256(raw body, webhook secret). */
export class RazorpayGateway extends VendorGateway {
  readonly name = 'razorpay' as const;
  async verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer) {
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    if (!safeEqual(header(headers, 'x-razorpay-signature'), expected)) throw new WebhookSignatureError();
    const body = JSON.parse(rawBody.toString('utf8'));
    const p = body?.payload?.payment?.entity ?? {};
    return {
      gatewayOrderId: String(p.order_id ?? ''),
      gatewayPaymentId: String(p.id ?? ''),
      status: p.status === 'captured' ? 'success' : p.status === 'failed' ? 'failed' : 'pending',
      amountPaise: Number(p.amount ?? 0),
      feePaise: p.fee != null ? Number(p.fee) : undefined,
      eventId: header(headers, 'x-razorpay-event-id') || undefined,
      raw: body,
    } satisfies VerifiedPayment;
  }
}

/** Cashfree (PG 2023-08-01): `x-webhook-signature` = base64 HMAC-SHA256(timestamp + raw body, secret key). */
export class CashfreeGateway extends VendorGateway {
  readonly name = 'cashfree' as const;
  async verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer) {
    const ts = header(headers, 'x-webhook-timestamp');
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(ts + rawBody.toString('utf8'))
      .digest('base64');
    if (!ts || !safeEqual(header(headers, 'x-webhook-signature'), expected))
      throw new WebhookSignatureError();
    const body = JSON.parse(rawBody.toString('utf8'));
    const d = body?.data ?? {};
    const status = d.payment?.payment_status;
    return {
      gatewayOrderId: String(d.order?.order_id ?? ''),
      gatewayPaymentId: String(d.payment?.cf_payment_id ?? ''),
      status: status === 'SUCCESS' ? 'success' : status === 'FAILED' ? 'failed' : 'pending',
      amountPaise: Math.round(Number(d.payment?.payment_amount ?? 0) * 100),
      feePaise: d.payment_gateway_details?.gateway_charges
        ? Math.round(Number(d.payment_gateway_details.gateway_charges) * 100)
        : undefined,
      eventId: header(headers, 'x-idempotency-key') || undefined,
      raw: body,
    } satisfies VerifiedPayment;
  }
}

/**
 * Paytm: callbacks/webhooks carry a `CHECKSUMHASH` produced with the merchant key (Paytm checksum
 * library, AES-based). Until the vendor library is integrated the webhook is not trusted; the
 * order status must be confirmed via the (pending) Transaction Status API.
 */
export class PaytmGateway extends VendorGateway {
  readonly name = 'paytm' as const;
  async verifyWebhook(): Promise<VerifiedPayment> {
    return this.unavailable('verifyWebhook (checksum)');
  }
}
