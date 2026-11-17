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
  raw: unknown;
}

/** Payment gateway adapter (Paytm, Razorpay, Cashfree...). Credentials are institute-owned. */
export interface PaymentGateway {
  readonly name: string;
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  /** Server-side verification of the authoritative status (never trust the client callback alone). */
  fetchStatus(gatewayOrderId: string): Promise<VerifiedPayment>;
  /** Validates webhook signature and parses the event. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<VerifiedPayment>;
  refund(gatewayPaymentId: string, amountPaise: number, idempotencyKey: string): Promise<{ refundId: string; status: string }>;
}
