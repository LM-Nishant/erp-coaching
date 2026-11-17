import crypto from 'node:crypto';
import type { CreateOrderInput, GatewayOrder, PaymentGateway, VerifiedPayment } from './types';

/** Development gateway: every order succeeds. */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mock';
  private orders = new Map<string, CreateOrderInput>();

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const gatewayOrderId = `mock_${input.orderId}`;
    this.orders.set(gatewayOrderId, input);
    return { gatewayOrderId, checkout: { mock: true, amountPaise: input.amountPaise } };
  }

  async fetchStatus(gatewayOrderId: string): Promise<VerifiedPayment> {
    const order = this.orders.get(gatewayOrderId);
    return {
      gatewayOrderId,
      gatewayPaymentId: `pay_${gatewayOrderId}`,
      status: order ? 'success' : 'failed',
      amountPaise: order?.amountPaise ?? 0,
      raw: { mock: true },
    };
  }

  async verifyWebhook(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<VerifiedPayment> {
    const body = JSON.parse(rawBody.toString());
    return this.fetchStatus(body.gatewayOrderId);
  }

  async refund(_paymentId: string, _amountPaise: number, idempotencyKey: string) {
    return {
      refundId: `rf_${crypto.createHash('sha1').update(idempotencyKey).digest('hex').slice(0, 12)}`,
      status: 'processed',
    };
  }
}
