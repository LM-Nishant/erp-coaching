export const PAYMENT_GATEWAY_NAMES = ['mock', 'paytm', 'razorpay', 'cashfree'] as const;
export type PaymentGatewayName = (typeof PAYMENT_GATEWAY_NAMES)[number];

/** Merchant credentials (institute-owned or platform-managed, stored encrypted by the owning module). */
export interface GatewayCredentials {
  /** Paytm MID / Razorpay key ID / Cashfree client (app) ID. */
  merchantId?: string;
  /** Paytm merchant key / Razorpay key secret / Cashfree client secret. */
  secretKey?: string;
  /** Razorpay webhook secret. Paytm and Cashfree sign webhooks with `secretKey`. */
  webhookSecret?: string;
  /** Vendor extras, e.g. Paytm `website` (WEBSTAGING in staging, DEFAULT in production unless Paytm says otherwise). */
  extra?: Record<string, string>;
  /** Use the vendor's sandbox / test environment. */
  sandbox?: boolean;
}

export interface CreateOrderInput {
  /** Our payment reference; vendors that need unique order IDs get a random suffix. */
  orderId: string;
  amountPaise: number;
  currency: 'INR';
  customer: { id?: string; name: string; mobile: string; email?: string };
  /** Absolute URL the vendor returns the payer's browser to (redirect flows). */
  callbackUrl: string;
  /** Absolute webhook URL for vendors that take it per order (Cashfree). */
  notifyUrl?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface GatewayOrder {
  gatewayOrderId: string;
  /** Data the client needs to open the vendor's checkout. Never contains secrets. */
  checkout: Record<string, unknown>;
}

export type GatewayPaymentStatus = 'success' | 'failed' | 'pending';

export interface VerifiedPayment {
  gatewayOrderId: string;
  /** Vendor payment / transaction ID ('' while nothing was attempted). */
  gatewayPaymentId: string;
  status: GatewayPaymentStatus;
  amountPaise: number;
  /** Gateway charges (MDR + GST) deducted by the gateway, when reported. */
  feePaise?: number;
  /** Payment method reported by the vendor (UPI, CARD, NB...). */
  method?: string;
  /** Bank / UTR reference, when reported. */
  bankReference?: string;
  /** Vendor's status message (failure reason etc.). */
  message?: string;
  /** Vendor event ID, when present (extra idempotency key). */
  eventId?: string;
  raw: unknown;
}

export interface RefundInput {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  amountPaise: number;
  /** Our unique refund reference (3–40 characters, [A-Za-z0-9_-]); re-sending it never refunds twice. */
  refundId: string;
  note?: string;
}

export type GatewayRefundStatus = 'processed' | 'pending' | 'failed';

export interface RefundResult {
  /** Our refund reference, as sent in `RefundInput.refundId`. */
  refundId: string;
  gatewayRefundId: string | null;
  status: GatewayRefundStatus;
  amountPaise: number;
  message?: string;
  raw?: unknown;
}

export interface RefundLookup {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  refundId: string;
  gatewayRefundId?: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

/** A verified webhook. Refund events carry our refund reference (`refund.refundId`) when the vendor echoes it. */
export type GatewayWebhookEvent =
  | ({ kind: 'payment' } & VerifiedPayment)
  | {
      kind: 'refund';
      refund: RefundResult & { gatewayOrderId?: string; gatewayPaymentId?: string };
      eventId?: string;
      raw: unknown;
    }
  | { kind: 'ignored'; reason: string; eventId?: string; raw: unknown };

/** Payment gateway adapter (Paytm, Razorpay, Cashfree, mock). */
export interface PaymentGateway {
  readonly name: PaymentGatewayName;
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  /** Server-side status check, the authority for marking a payment paid (never trust the client). */
  fetchStatus(gatewayOrderId: string): Promise<VerifiedPayment>;
  /** Validates the webhook signature (throws `WebhookSignatureError`) and parses the event. */
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<GatewayWebhookEvent>;
  /**
   * Requests a refund. Resolves with the vendor's answer (`failed` = the vendor rejected it). Throws
   * `GatewayRequestError`: retryable means the outcome is unknown, so check `fetchRefundStatus` later.
   */
  refund(input: RefundInput): Promise<RefundResult>;
  /** Current refund state, or null when the vendor has no refund with this reference. */
  fetchRefundStatus(lookup: RefundLookup): Promise<RefundResult | null>;
  /** Checks the credentials against the vendor without moving money. */
  testConnection(): Promise<ConnectionTestResult>;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
  }
}

/** Missing or unusable credentials / settings. The message is safe to show to admins. */
export class GatewayConfigError extends Error {}

/** A vendor call failed. The message is safe to show (it never contains credentials). */
export class GatewayRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
  /** True when the outcome is unknown or temporary (network, timeout, 429, 5xx): retry or check later. */
  readonly retryable: boolean;

  constructor(
    readonly gateway: PaymentGatewayName,
    message: string,
    opts: { status?: number; code?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
  }
}
