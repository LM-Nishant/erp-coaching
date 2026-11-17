import { MockPaymentGateway } from './mock.gateway';
import type { PaymentGateway } from './types';

export * from './types';

const mock = new MockPaymentGateway();

/** Resolve gateway for an institute. Real gateways will read institute-owned encrypted credentials. */
export function getPaymentGateway(_instituteId: number, name = 'mock'): PaymentGateway {
  if (name === 'mock') return mock;
  throw new Error(`Payment gateway "${name}" is not implemented yet`);
}
