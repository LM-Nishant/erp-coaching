import { MockPaymentGateway } from './mock.gateway';
import { CashfreeGateway, PaytmGateway, RazorpayGateway } from './vendor.gateways';
import type { GatewayCredentials, PaymentGateway, PaymentGatewayName } from './types';

export * from './types';
export { MOCK_SIGNATURE_HEADER, MockPaymentGateway, signMockWebhook } from './mock.gateway';

/**
 * Builds the adapter for a gateway with the institute's own (decrypted) merchant credentials.
 * Business modules load and decrypt credentials; vendor SDK/HTTP details stay in this folder.
 */
export function createPaymentGateway(
  name: PaymentGatewayName,
  creds: GatewayCredentials = {},
): PaymentGateway {
  switch (name) {
    case 'mock':
      return new MockPaymentGateway(creds);
    case 'razorpay':
      return new RazorpayGateway(creds);
    case 'cashfree':
      return new CashfreeGateway(creds);
    case 'paytm':
      return new PaytmGateway(creds);
    default:
      throw new Error(`Payment gateway "${name as string}" is not supported`);
  }
}

/** @deprecated Use `createPaymentGateway(name, institute credentials)`. */
export function getPaymentGateway(_instituteId: number, name: PaymentGatewayName = 'mock'): PaymentGateway {
  return createPaymentGateway(name);
}
