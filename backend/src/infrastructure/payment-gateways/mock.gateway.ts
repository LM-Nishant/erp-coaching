import crypto from 'node:crypto';
import {
  WebhookSignatureError,
  type CreateOrderInput,
  type GatewayCredentials,
  type GatewayOrder,
  type PaymentGateway,
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
  ): Promise<VerifiedPayment> {
    const sig = String(headers[MOCK_SIGNATURE_HEADER] ?? '');
    const expected = signMockWebhook(this.secret, rawBody);
    if (
      !sig ||
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      throw new WebhookSignatureError();
    const body = JSON.parse(rawBody.toString('utf8')) as {
      eventId?: string;
      gatewayOrderId: string;
      gatewayPaymentId: string;
      amountPaise: number;
      feePaise?: number;
      status: VerifiedPayment['status'];
    };
    return {
      gatewayOrderId: body.gatewayOrderId,
      gatewayPaymentId: body.gatewayPaymentId,
      status: body.status,
      amountPaise: body.amountPaise,
      feePaise: body.feePaise,
      eventId: body.eventId,
      raw: body,
    };
  }

  async refund(_paymentId: string, _amountPaise: number, idempotencyKey: string) {
    return {
      refundId: `rf_${crypto.createHash('sha1').update(idempotencyKey).digest('hex').slice(0, 12)}`,
      status: 'processed' as const,
    };
  }
}
