import { CashfreeGateway } from './cashfree.gateway';
import { MockPaymentGateway } from './mock.gateway';
import { PaytmGateway } from './paytm.gateway';
import { RazorpayGateway } from './razorpay.gateway';
import type { GatewayCredentials, PaymentGateway, PaymentGatewayName } from './types';

export * from './types';
export { GATEWAY_LABELS, setPaymentGatewayHttp } from './http';
export type { GatewayHttp, GatewayHttpRequest, GatewayHttpResponse } from './http';
export { MOCK_SIGNATURE_HEADER, MockPaymentGateway, signMockWebhook } from './mock.gateway';

/**
 * Builds the adapter for a gateway with the owner's (decrypted) merchant credentials: the
 * institute's own, or the platform-managed ones. Business modules load and decrypt credentials;
 * vendor HTTP details stay in this folder.
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
