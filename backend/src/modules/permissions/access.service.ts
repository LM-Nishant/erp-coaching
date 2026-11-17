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
      include: [{ model: Role, as: 'role', include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }] }],
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
