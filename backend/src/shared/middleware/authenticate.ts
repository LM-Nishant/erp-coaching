import type { Request, RequestHandler } from 'express';
import { Unauthorized, Forbidden } from '../errors';
import type { RequestContext } from '../context';
import { User } from '../../modules/users/user.model';
import { Institute } from '../../modules/institutes/institute.model';
import { Branch } from '../../modules/branches/branch.model';
import { Device, ImpersonationSession } from '../../modules/authentication/models';
import { verifyAccessToken } from '../../modules/authentication/token.service';
import {
  computeAccess,
  loadAssignments,
  type ResolvedAccess,
} from '../../modules/permissions/access.service';
import {
  ACTIVITY_TOUCH_INTERVAL_MS,
  BACKGROUND_REQUEST_HEADER,
  getIdleTimeoutMinutes,
  isIdle,
} from '../session-policy';

/** Extra check for tenant requests, run once the context is filled. Throw an AppError to refuse. */
export type TenantRequestGuard = (req: Request) => Promise<void> | void;

const tenantGuards = new Map<string, TenantRequestGuard>();

/**
 * Registers a tenant request guard (e.g. subscriptions blocks writes for a lapsed subscription).
 * Keyed by name so re-registration replaces instead of duplicating.
 */
export function addTenantRequestGuard(name: string, guard: TenantRequestGuard): void {
  tenantGuards.set(name, guard);
}

/**
 * Verifies the bearer token and fills the request context (user, device, institute, roles,
 * permissions, allowed branches). Tenant comes ONLY from the signed token; the optional
 * `X-Branch-Id` header is validated against the user's allowed branches.
 *
 * Also enforces the institute's inactivity timeout (401 `SESSION_IDLE`) and records activity on the
 * device (`lastSeenAt`), except for background polls sent with `X-Background-Request: 1`.
 *
 * Order matters: the session checks (401 `SESSION_REVOKED`, `SESSION_IDLE`) run before the tenant request guards
 * (e.g. 402 `SUBSCRIPTION_SUSPENDED`), so a revoked or idle device signs out even while the subscription is
 * suspended. The live-class socket handshake runs this too, with a request without URL or method.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw Unauthorized();
  const claims = verifyAccessToken(header.slice(7));
  const ctx = req.ctx;

  const user = await User.findByPk(claims.sub);
  if (!user || user.status !== 'active') {
    // While impersonating, `sub` is the impersonated user: only the impersonation ends, not the super admin's session.
    if (claims.imp) throw Unauthorized('Impersonation session ended', 'IMPERSONATION_ENDED');
    throw Unauthorized('Account is not active', 'ACCOUNT_INACTIVE');
  }

  const device = await Device.findByPk(claims.did);
  if (!device || device.status !== 'active' || device.userId !== (claims.imp ?? claims.sub)) {
    throw Unauthorized('This device session has been revoked', 'SESSION_REVOKED');
  }

  if (claims.imp) {
    const session = claims.isid ? await ImpersonationSession.findByPk(claims.isid) : null;
    if (
      !session ||
      session.endedAt ||
      session.expiresAt < new Date() ||
      session.superAdminId !== claims.imp
    ) {
      throw Unauthorized('Impersonation session ended', 'IMPERSONATION_ENDED');
    }
    ctx.impersonatorId = claims.imp;
    ctx.impersonationSessionId = session.id;
  } else if (isIdle(device.lastSeenAt, await getIdleTimeoutMinutes(claims.inst ?? null))) {
    throw Unauthorized('Signed out after a period of inactivity', 'SESSION_IDLE');
  }

  ctx.userId = user.id;
  ctx.isSuperAdmin = user.isSuperAdmin;
  ctx.deviceId = device.id;

  if (claims.inst) {
    const institute = await Institute.findByPk(claims.inst);
    if (!institute) throw Unauthorized('Institute not found', 'INSTITUTE_NOT_FOUND');
    if (institute.status !== 'active' && !ctx.impersonatorId) {
      throw Forbidden(`Institute is ${institute.status}`, 'INSTITUTE_NOT_ACTIVE');
    }
    const data = await loadAssignments(user.id, institute.id);
    if (!data.assignments.length)
      throw Forbidden('You are no longer a member of this institute', 'NOT_A_MEMBER');

    let activeBranchId: number | undefined;
    const branchHeader = req.header('x-branch-id');
    if (branchHeader) {
      activeBranchId = Number(branchHeader);
      const allowed = computeAccess(data).allowedBranchIds;
      const permitted =
        Number.isInteger(activeBranchId) &&
        (allowed !== null
          ? allowed.includes(activeBranchId)
          : (await Branch.count({ where: { instituteId: institute.id, id: activeBranchId } })) > 0);
      if (!permitted) throw Forbidden('You do not have access to this branch', 'BRANCH_FORBIDDEN');
    }
    const access = computeAccess(data, activeBranchId);
    ctx.instituteId = institute.id;
    ctx.activeBranchId = activeBranchId;
    ctx.allowedBranchIds = access.allowedBranchIds;
    ctx.roles = access.roles;
    ctx.permissions = access.permissions;
    for (const guard of tenantGuards.values()) await guard(req);
  } else {
    ctx.roles = [];
    ctx.permissions = new Set();
  }

  const now = Date.now();
  if (
    req.header(BACKGROUND_REQUEST_HEADER) !== '1' &&
    (!device.lastSeenAt || now - device.lastSeenAt.getTime() > ACTIVITY_TOUCH_INTERVAL_MS)
  ) {
    await Device.update({ lastSeenAt: new Date(now), lastIp: ctx.ip ?? null }, { where: { id: device.id } });
  }
  next();
};

/**
 * Re-checks a session that `authenticate` accepted earlier, without its access token (which may have
 * expired since): open live-class sockets are authenticated once, at the handshake. Applies the same
 * rules: the device is still active and not idle (or the impersonation still running), the user and
 * institute are active, the user is still a member (and may use the selected branch), and the tenant
 * request guards pass for a read (a suspended subscription → 402). Throws the error `authenticate`
 * would; returns the user's current access in the institute (null without one). Run it in `ctx`.
 */
export async function recheckSession(ctx: RequestContext): Promise<ResolvedAccess | null> {
  const [user, device] = await Promise.all([
    User.findByPk(ctx.userId, { attributes: ['id', 'status'] }),
    Device.findByPk(ctx.deviceId),
  ]);
  if (!user || user.status !== 'active') {
    if (ctx.impersonatorId) throw Unauthorized('Impersonation session ended', 'IMPERSONATION_ENDED');
    throw Unauthorized('Account is not active', 'ACCOUNT_INACTIVE');
  }
  if (!device || device.status !== 'active' || device.userId !== (ctx.impersonatorId ?? ctx.userId))
    throw Unauthorized('This device session has been revoked', 'SESSION_REVOKED');
  if (ctx.impersonatorId) {
    const session = ctx.impersonationSessionId
      ? await ImpersonationSession.findByPk(ctx.impersonationSessionId)
      : null;
    if (
      !session ||
      session.endedAt ||
      session.expiresAt < new Date() ||
      session.superAdminId !== ctx.impersonatorId
    )
      throw Unauthorized('Impersonation session ended', 'IMPERSONATION_ENDED');
  } else if (isIdle(device.lastSeenAt, await getIdleTimeoutMinutes(ctx.instituteId ?? null))) {
    throw Unauthorized('Signed out after a period of inactivity', 'SESSION_IDLE');
  }
  if (!ctx.instituteId) return null;
  const institute = await Institute.findByPk(ctx.instituteId, { attributes: ['id', 'status'] });
  if (!institute) throw Unauthorized('Institute not found', 'INSTITUTE_NOT_FOUND');
  if (institute.status !== 'active' && !ctx.impersonatorId)
    throw Forbidden(`Institute is ${institute.status}`, 'INSTITUTE_NOT_ACTIVE');
  const data = await loadAssignments(user.id, institute.id);
  if (!data.assignments.length)
    throw Forbidden('You are no longer a member of this institute', 'NOT_A_MEMBER');
  const allowed = computeAccess(data).allowedBranchIds;
  const branchId = ctx.activeBranchId ?? undefined;
  if (branchId !== undefined && allowed !== null && !allowed.includes(branchId))
    throw Forbidden('You do not have access to this branch', 'BRANCH_FORBIDDEN');
  const req = { ctx, header: () => undefined } as unknown as Request;
  for (const guard of tenantGuards.values()) await guard(req);
  return computeAccess(data, branchId);
}
