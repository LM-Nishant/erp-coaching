import { AsyncLocalStorage } from 'node:async_hooks';
import { Forbidden, Unauthorized } from './errors';

/**
 * Per-request (or per-job) context. Populated by `authenticate` from the verified access token —
 * never from client-supplied tenant ids.
 */
export interface RequestContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  userId?: number;
  isSuperAdmin?: boolean;
  /** Real super admin user id when impersonating. */
  impersonatorId?: number;
  impersonationSessionId?: number;
  deviceId?: number;
  instituteId?: number;
  /** null = all branches of the institute. */
  allowedBranchIds?: number[] | null;
  /** Branch selected via `X-Branch-Id` header (validated). */
  activeBranchId?: number;
  roles?: string[];
  permissions?: Set<string>;
  /** Set for background jobs / system tasks. */
  system?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext {
  return storage.getStore() ?? {};
}

export interface TenantContext extends RequestContext {
  instituteId: number;
  allowedBranchIds: number[] | null;
}

/** Throws unless the current context is bound to an institute. */
export function requireTenantContext(): TenantContext {
  const ctx = getContext();
  if (!ctx.instituteId) {
    if (!ctx.userId && !ctx.system) throw Unauthorized();
    throw Forbidden('Select an institute first', 'INSTITUTE_REQUIRED');
  }
  return {
    ...ctx,
    instituteId: ctx.instituteId,
    allowedBranchIds: ctx.allowedBranchIds ?? null,
  } as TenantContext;
}

export function hasPermission(key: string): boolean {
  const ctx = getContext();
  if (ctx.system) return true;
  if (ctx.isSuperAdmin && !ctx.impersonatorId) return true;
  return ctx.permissions?.has(key) ?? false;
}
