import { literal, Op, type WhereOptions } from 'sequelize';
import { requireTenantContext } from '../../shared/context';
import { Forbidden, NotFound } from '../../shared/errors';
import { Permission, Role, UserBranch, UserRole } from './models';

export interface Assignment {
  roleSlug: string;
  roleName: string;
  branchId: number | null;
  permissions: string[];
}

export interface ResolvedAccess {
  roles: string[];
  permissions: Set<string>;
  /** null → all branches. */
  allowedBranchIds: number[] | null;
}

export async function loadAssignments(userId: number, instituteId: number) {
  const [roles, branches] = await Promise.all([
    UserRole.findAll({
      where: { userId, instituteId },
      include: [
        {
          model: Role,
          as: 'role',
          include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }],
        },
      ],
    }),
    UserBranch.findAll({ where: { userId, instituteId } }),
  ]);
  const assignments: Assignment[] = roles.map((ur) => ({
    roleSlug: ur.role!.slug,
    roleName: ur.role!.name,
    branchId: ur.branchId,
    permissions: (ur.role!.permissions ?? []).map((p) => p.key),
  }));
  return { assignments, userBranchIds: branches.map((b) => b.branchId) };
}

/**
 * Computes effective access. Institute-wide assignments (branchId null) grant all branches;
 * branch-specific assignments grant their permissions only when that branch is active (or when
 * no branch is selected, across the user's allowed branches).
 */
export function computeAccess(
  data: { assignments: Assignment[]; userBranchIds: number[] },
  activeBranchId?: number,
): ResolvedAccess {
  const instituteWide = data.assignments.some((a) => a.branchId === null);
  const allowedBranchIds = instituteWide
    ? null
    : [...new Set([...data.userBranchIds, ...data.assignments.map((a) => a.branchId as number)])];
  const effective = data.assignments.filter(
    (a) => a.branchId === null || activeBranchId === undefined || a.branchId === activeBranchId,
  );
  return {
    roles: [...new Set(effective.map((a) => a.roleSlug))],
    permissions: new Set(effective.flatMap((a) => a.permissions)),
    allowedBranchIds,
  };
}

export async function resolveAccess(userId: number, instituteId: number, activeBranchId?: number) {
  return computeAccess(await loadAssignments(userId, instituteId), activeBranchId);
}

/** Institutes in which the user has at least one role. */
export async function membershipInstituteIds(userId: number): Promise<number[]> {
  const rows = await UserRole.findAll({
    where: { userId },
    attributes: ['instituteId'],
    group: ['instituteId'],
    // Cross-tenant by design: lists the caller's own memberships.
    tenantBypass: true,
  } as object);
  return rows.map((r) => r.instituteId);
}

/**
 * Branch boundary for managing members. Branch-restricted callers see institute-level staff and
 * members who share one of their branches (404 otherwise), and may only manage members whose every
 * assignment lies inside their branches (403 otherwise). Institute-wide callers are unrestricted.
 */
export async function assertMemberInBranchScope(userId: number, mode: 'read' | 'manage'): Promise<void> {
  const { instituteId, allowedBranchIds: allowed } = requireTenantContext();
  if (allowed === null) return;
  const footprint = computeAccess(await loadAssignments(userId, instituteId)).allowedBranchIds;
  if (footprint !== null && !footprint.some((b) => allowed.includes(b))) throw NotFound('User');
  if (mode === 'manage' && (footprint === null || !footprint.every((b) => allowed.includes(b))))
    throw Forbidden('This member belongs to branches outside your access', 'BRANCH_FORBIDDEN');
}

/** `User` filter matching {@link assertMemberInBranchScope} read access; undefined when unrestricted. */
export function memberVisibilityWhere(): WhereOptions | undefined {
  const { instituteId, allowedBranchIds } = requireTenantContext();
  if (allowedBranchIds === null) return undefined;
  const branches = allowedBranchIds.length ? allowedBranchIds.map((b) => Number(b)).join(',') : 'NULL';
  const inst = Number(instituteId);
  return {
    id: {
      [Op.in]: literal(
        `(SELECT user_id FROM user_roles WHERE institute_id = ${inst} AND (branch_id IS NULL OR branch_id IN (${branches}))` +
          ` UNION SELECT user_id FROM user_branches WHERE institute_id = ${inst} AND branch_id IN (${branches}))`,
      ),
    },
  };
}
