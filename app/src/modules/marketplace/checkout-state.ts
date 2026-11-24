import type { MktCheckoutDto } from '@erp/shared';

/** Gateway checkouts started in this app session, by order id: the order page opens them. */
export const pendingCheckouts = new Map<number, NonNullable<MktCheckoutDto['payment']>>();
