export const PAYMENT_GATEWAY_NAMES = ['mock', 'paytm', 'razorpay', 'cashfree'] as const;
export type PaymentGatewayName = (typeof PAYMENT_GATEWAY_NAMES)[number];

/** Institute-owned merchant credentials (stored encrypted by the owning module). */
export interface GatewayCredentials {
  /** Paytm MID / Razorpay key id / Cashfree app id. */
  merchantId?: string;
  /** Paytm merchant key / Razorpay key secret / Cashfree secret key. */
  secretKey?: string;
  /** Secret used to sign webhooks (Razorpay webhook secret; defaults to `secretKey`). */
  webhookSecret?: string;
  /** Paytm website / industry etc. */
  extra?: Record<string, string>;
  /** Use the vendor's sandbox environment. */
  sandbox?: boolean;
}

export interface CreateOrderInput {
  /** Idempotency key / our payment order id. */
  orderId: string;
  amountPaise: number;
  currency: 'INR';
  customer: { name: string; mobile: string; email?: string };
  callbackUrl: string;
  metadata?: Record<string, string>;
}

export interface GatewayOrder {
  gatewayOrderId: string;
  /** Data the client needs to open checkout (gateway specific). */
  checkout: Record<string, unknown>;
}

export interface VerifiedPayment {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  status: 'success' | 'failed' | 'pending';
  amountPaise: number;
  /** Gateway charges (MDR + GST) deducted by the gateway, when reported. */
  feePaise?: number;
  /** Vendor event id, when present (extra idempotency key). */
  eventId?: string;
  raw: unknown;
}

/** Payment gateway adapter (Paytm, Razorpay, Cashfree...). Credentials are institute-owned. */
export interface PaymentGateway {
  readonly name: PaymentGatewayName;
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  /** Server-side verification of the authoritative status (never trust the client callback alone). */
  fetchStatus(gatewayOrderId: string): Promise<VerifiedPayment>;
  /** Validates the webhook signature (throws `WebhookSignatureError`) and parses the event. */
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<VerifiedPayment>;
  refund(
    gatewayPaymentId: string,
    amountPaise: number,
    idempotencyKey: string,
  ): Promise<{ refundId: string; status: 'processed' | 'pending' | 'failed' }>;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
  }
}

export class GatewayNotAvailableError extends Error {}
