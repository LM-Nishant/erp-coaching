import type { Request } from 'express';
import { SUBSCRIPTION_ERROR_CODES } from '@erp/shared';
import { AppError } from '../../shared/errors';
import { getAccessStateCached } from './subscription.service';

/** Reachable in every state: sign-in/out, the billing page (to pay) and data export. */
const ALWAYS_ALLOWED = [/^\/api\/auth(\/|$)/, /^\/api\/subscription(\/|$)/, /^\/api\/tenant-data(\/|$)/];
/** Writes that stay allowed while read-only (personal notification state, not institute data). */
const RESTRICTED_WRITES = [/^\/api\/notifications\/(inbox|preferences|push-tokens)(\/|$)/];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Tenant request guard: after the grace period a lapsed institute is read-only (`restricted`,
 * writes get 402 SUBSCRIPTION_RESTRICTED), and a suspended one can only reach billing (402
 * SUBSCRIPTION_SUSPENDED). Super admins, also while impersonating, are never blocked.
 */
export async function subscriptionAccessGuard(req: Request): Promise<void> {
  const ctx = req.ctx;
  if (!ctx.instituteId || ctx.isSuperAdmin || ctx.impersonatorId) return;
  // Non-HTTP callers (the live-class socket handshake) pass a request without a URL or method. They
  // count as reads, so a suspended institute is refused and a read-only one is not.
  const path = (req.originalUrl ?? '').split('?')[0];
  const method = req.method ?? 'GET';
  if (ALWAYS_ALLOWED.some((r) => r.test(path))) return;
  const { state } = await getAccessStateCached(ctx.instituteId);
  if (state === 'suspended')
    throw new AppError(
      402,
      SUBSCRIPTION_ERROR_CODES.SUSPENDED,
      'The subscription is suspended. Renew it from Subscription & billing or contact support.',
      { state },
    );
  if (state === 'restricted' && !READ_METHODS.has(method) && !RESTRICTED_WRITES.some((r) => r.test(path)))
    throw new AppError(
      402,
      SUBSCRIPTION_ERROR_CODES.RESTRICTED,
      'The subscription has expired and the app is read-only. Renew it from Subscription & billing.',
      { state },
    );
}
