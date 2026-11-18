/**
 * Public reports API for other modules. Import only from this file:
 *
 *   import { setSaasBillingStatsProvider } from '../reports/api';
 *   setSaasBillingStatsProvider(async (period) => ({ source: 'billing', ... }));
 */
export { setSaasBillingStatsProvider, type SaasBillingStatsProvider, type SaasPeriod } from './saas';
