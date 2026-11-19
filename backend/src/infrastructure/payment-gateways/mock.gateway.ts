import crypto from 'node:crypto';
import { safeEqual } from './http';
import {
  WebhookSignatureError,
  type ConnectionTestResult,
  type CreateOrderInput,
  type GatewayCredentials,
  type GatewayOrder,
  type GatewayWebhookEvent,
  type PaymentGateway,
  type RefundInput,
  type RefundLookup,
  type RefundResult,
  type VerifiedPayment,
} from './types';

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

type Outcome = 'success' | 'failed';
interface MockOrder {
  amountPaise: number;
  outcome?: Outcome;
}

// Shared across instances so orders survive per-request adapter construction (process memory only).
const orders = new Map<string, MockOrder>();
const refunds = new Map<string, number>();

/** HMAC-SHA256 (hex) of the raw webhook body, like Razorpay/Cashfree style signed webhooks. */
export function signMockWebhook(secret: string, rawBody: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Development/test gateway: order → hosted checkout (simulated) → signed webhook. Charges a 2%
 * gateway fee so gateway-charge accounting is exercised.
 */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mock' as const;
  private readonly secret: string;

  constructor(creds: GatewayCredentials = {}) {
    this.secret = creds.webhookSecret || creds.secretKey || 'mock-webhook-secret';
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const gatewayOrderId = `mock_${input.orderId}`;
    if (!orders.has(gatewayOrderId)) orders.set(gatewayOrderId, { amountPaise: input.amountPaise });
    return {
      gatewayOrderId,
      checkout: {
        provider: 'mock',
        mock: true,
        gatewayOrderId,
        amountPaise: input.amountPaise,
        callbackUrl: input.callbackUrl,
      },
    };
  }

  private payment(gatewayOrderId: string): VerifiedPayment {
    const order = orders.get(gatewayOrderId);
    const status = order?.outcome ?? 'pending';
    return {
      gatewayOrderId,
      gatewayPaymentId: `pay_${gatewayOrderId}`,
      status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending',
      amountPaise: order?.amountPaise ?? 0,
      feePaise: status === 'success' ? Math.round((order?.amountPaise ?? 0) * 0.02) : 0,
      eventId: `evt_${gatewayOrderId}_${status}`,
      raw: { mock: true },
    };
  }

  async fetchStatus(gatewayOrderId: string): Promise<VerifiedPayment> {
    return this.payment(gatewayOrderId);
  }

  /**
   * Simulates the customer finishing the hosted checkout. Returns the signed webhook the gateway
   * would deliver (body + headers) so callers can post it to the webhook endpoint.
   */
  completeCheckout(gatewayOrderId: string, outcome: Outcome, amountPaise?: number) {
    let order = orders.get(gatewayOrderId);
    if (!order) {
      if (amountPaise == null) throw new Error('Unknown mock order');
      // Orders live in memory; re-create after a restart from the caller's stored amount.
      order = { amountPaise };
      orders.set(gatewayOrderId, order);
    }
    order.outcome = outcome;
    const p = this.payment(gatewayOrderId);
    const body = JSON.stringify({
      event: outcome === 'success' ? 'payment.captured' : 'payment.failed',
      eventId: p.eventId,
      gatewayOrderId,
      gatewayPaymentId: p.gatewayPaymentId,
      amountPaise: p.amountPaise,
      feePaise: p.feePaise,
      status: p.status,
    });
    return { body, headers: { [MOCK_SIGNATURE_HEADER]: signMockWebhook(this.secret, body) } };
  }

  async verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<GatewayWebhookEvent> {
    const sig = String(headers[MOCK_SIGNATURE_HEADER] ?? '');
    if (!sig || !safeEqual(sig, signMockWebhook(this.secret, rawBody))) throw new WebhookSignatureError();
    const body = JSON.parse(rawBody.toString('utf8')) as {
      eventId?: string;
      gatewayOrderId: string;
      gatewayPaymentId: string;
      amountPaise: number;
      feePaise?: number;
      status: VerifiedPayment['status'];
    };
    return {
      kind: 'payment',
      gatewayOrderId: body.gatewayOrderId,
      gatewayPaymentId: body.gatewayPaymentId,
      status: body.status,
      amountPaise: body.amountPaise,
      feePaise: body.feePaise,
      eventId: body.eventId,
      raw: body,
    };
  }

  /** Refunds complete immediately; the same reference always returns the same refund. */
  async refund(input: RefundInput): Promise<RefundResult> {
    if (!refunds.has(input.refundId)) refunds.set(input.refundId, input.amountPaise);
    return this.refundResult(input.refundId);
  }

  async fetchRefundStatus(lookup: RefundLookup): Promise<RefundResult | null> {
    return refunds.has(lookup.refundId) ? this.refundResult(lookup.refundId) : null;
  }

  private refundResult(refundId: string): RefundResult {
    return {
      refundId,
      gatewayRefundId: `rf_${crypto.createHash('sha1').update(refundId).digest('hex').slice(0, 12)}`,
      status: 'processed',
      amountPaise: refunds.get(refundId) ?? 0,
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, message: 'Created test order (mock gateway, no money moves)' };
  }
}
