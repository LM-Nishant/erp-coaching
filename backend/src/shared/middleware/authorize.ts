import type { RequestHandler } from 'express';
import type { PermissionAction } from '@erp/shared';
import { Forbidden, Unauthorized } from '../errors';
import { hasPermission } from '../context';
import { isModuleEnabled } from '../../modules/subscriptions/subscription.service';

/** Requires an institute to be selected in the token (tenant routes). */
export const requireTenant: RequestHandler = (req, _res, next) => {
  if (!req.ctx.userId) throw Unauthorized();
  if (!req.ctx.instituteId) throw Forbidden('Select an institute first', 'INSTITUTE_REQUIRED');
  next();
};

/** Platform administrator (not while impersonating). */
export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  if (!req.ctx.userId) throw Unauthorized();
  if (!req.ctx.isSuperAdmin || req.ctx.impersonatorId)
    throw Forbidden('Super admin only', 'SUPER_ADMIN_ONLY');
  next();
};

/**
 * `requirePermission('branches', 'create')`. Enforced on the backend for every protected route.
 * Implies requireTenant unless the caller is a (non-impersonating) super admin.
 */
export function requirePermission(module: string, action: PermissionAction): RequestHandler {
  const key = `${module}.${action}`;
  return (req, _res, next) => {
    if (!req.ctx.userId) throw Unauthorized();
    const platformAdmin = req.ctx.isSuperAdmin && !req.ctx.impersonatorId;
    if (!platformAdmin && !req.ctx.instituteId)
      throw Forbidden('Select an institute first', 'INSTITUTE_REQUIRED');
    if (!hasPermission(key)) throw Forbidden(`Missing permission ${key}`, 'PERMISSION_DENIED');
    next();
  };
}

/** Blocks routes of modules that the institute's plan does not enable. */
export function requireModule(moduleName: string): RequestHandler {
  return async (req, _res, next) => {
    if (req.ctx.instituteId && !(await isModuleEnabled(req.ctx.instituteId, moduleName))) {
      throw Forbidden(`The ${moduleName} module is not enabled for this institute`, 'MODULE_DISABLED');
    }
    next();
  };
}
