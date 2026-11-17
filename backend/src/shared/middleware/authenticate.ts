import type { RequestHandler } from 'express';
import { Unauthorized, Forbidden } from '../errors';
import { User } from '../../modules/users/user.model';
import { Institute } from '../../modules/institutes/institute.model';
import { Branch } from '../../modules/branches/branch.model';
import { Device, ImpersonationSession } from '../../modules/authentication/models';
import { verifyAccessToken } from '../../modules/authentication/token.service';
import { computeAccess, loadAssignments } from '../../modules/permissions/access.service';

/**
 * Verifies the bearer token and fills the request context (user, device, institute, roles,
 * permissions, allowed branches). Tenant comes ONLY from the signed token; the optional
 * `X-Branch-Id` header is validated against the user's allowed branches.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw Unauthorized();
  const claims = verifyAccessToken(header.slice(7));
  const ctx = req.ctx;

  const user = await User.findByPk(claims.sub);
  if (!user || user.status !== 'active') throw Unauthorized('Account is not active', 'ACCOUNT_INACTIVE');

  const device = await Device.findByPk(claims.did);
  if (!device || device.status !== 'active' || device.userId !== (claims.imp ?? claims.sub)) {
    throw Unauthorized('This device session has been revoked', 'SESSION_REVOKED');
  }

  if (claims.imp) {
    const session = claims.isid ? await ImpersonationSession.findByPk(claims.isid) : null;
    if (!session || session.endedAt || session.expiresAt < new Date() || session.superAdminId !== claims.imp) {
      throw Unauthorized('Impersonation session ended', 'IMPERSONATION_ENDED');
    }
    ctx.impersonatorId = claims.imp;
    ctx.impersonationSessionId = session.id;
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
    if (!data.assignments.length) throw Forbidden('You are no longer a member of this institute', 'NOT_A_MEMBER');

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
  } else {
    ctx.roles = [];
    ctx.permissions = new Set();
  }
  next();
};
