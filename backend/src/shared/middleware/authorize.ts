import type { RequestHandler } from 'express';
import type { PermissionAction } from '@erp/shared';
import { Forbidden, Unauthorized } from '../errors';
import { hasPermission } from '../context';
import { isModuleEnabled } from '../../modules/subscriptions/subscription.service';

/** What a guard enforces; read by the route registry (security tests, route inventory). */
export type RouteGuard =
  | { type: 'tenant' }
  | { type: 'superAdmin' }
  | { type: 'permission'; key: string }
  | { type: 'module'; module: string };

const guards = new WeakMap<object, RouteGuard>();

function tagGuard<T extends RequestHandler>(fn: T, guard: RouteGuard): T {
  guards.set(fn, guard);
  return fn;
}

export const routeGuardOf = (fn: unknown): RouteGuard | undefined =>
  typeof fn === 'function' ? guards.get(fn) : undefined;

/** Requires an institute to be selected in the token (tenant routes). */
export const requireTenant: RequestHandler = tagGuard(
  (req, _res, next) => {
    if (!req.ctx.userId) throw Unauthorized();
    if (!req.ctx.instituteId) throw Forbidden('Select an institute first', 'INSTITUTE_REQUIRED');
    next();
  },
  { type: 'tenant' },
);

/** Platform administrator (not while impersonating). */
export const requireSuperAdmin: RequestHandler = tagGuard(
  (req, _res, next) => {
    if (!req.ctx.userId) throw Unauthorized();
    if (!req.ctx.isSuperAdmin || req.ctx.impersonatorId)
      throw Forbidden('Super admin only', 'SUPER_ADMIN_ONLY');
    next();
  },
  { type: 'superAdmin' },
);

/**
 * `requirePermission('branches', 'create')`. Enforced on the backend for every protected route.
 * Implies requireTenant unless the caller is a (non-impersonating) super admin.
 */
export function requirePermission(module: string, action: PermissionAction): RequestHandler {
  const key = `${module}.${action}`;
  return tagGuard(
    (req, _res, next) => {
      if (!req.ctx.userId) throw Unauthorized();
      const platformAdmin = req.ctx.isSuperAdmin && !req.ctx.impersonatorId;
      if (!platformAdmin && !req.ctx.instituteId)
        throw Forbidden('Select an institute first', 'INSTITUTE_REQUIRED');
      if (!hasPermission(key)) throw Forbidden(`Missing permission ${key}`, 'PERMISSION_DENIED');
      next();
    },
    { type: 'permission', key },
  );
}

/** Blocks routes of modules that the institute's plan does not enable. */
export function requireModule(moduleName: string): RequestHandler {
  return tagGuard(
    async (req, _res, next) => {
      if (req.ctx.instituteId && !(await isModuleEnabled(req.ctx.instituteId, moduleName))) {
        throw Forbidden(`The ${moduleName} module is not enabled for this institute`, 'MODULE_DISABLED');
      }
      next();
    },
    { type: 'module', module: moduleName },
  );
}
