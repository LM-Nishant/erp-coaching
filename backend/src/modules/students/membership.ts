import { Op, type Transaction } from 'sequelize';
import { requireTenantContext } from '../../shared/context';
import { Role, UserBranch, UserRole } from '../permissions/models';

export type PortalRole = 'student' | 'parent';

const roleIds = new Map<PortalRole, number>();

/** System role ids never change; cached so no extra pooled connection is needed mid-transaction. */
async function systemRoleId(slug: PortalRole, transaction?: Transaction): Promise<number> {
  const cached = roleIds.get(slug);
  if (cached) return cached;
  const role = await Role.findOne({ where: { instituteId: null, slug }, transaction });
  if (!role) throw new Error(`System role ${slug} missing; run migrations/seeders`);
  roleIds.set(slug, role.id);
  return role.id;
}

/**
 * Makes the user hold `slug` in exactly `branchIds` (one branch-scoped assignment per branch).
 *
 * Branch-scoped on purpose: an institute-wide role would widen the branch access of any staff role
 * the same user may hold, and branch-specific permissions only apply while that branch is active,
 * so a parent with children in two branches needs the role in both.
 */
export async function syncBranchRoles(
  userId: number,
  slug: PortalRole,
  branchIds: number[],
  transaction?: Transaction,
): Promise<void> {
  const { instituteId } = requireTenantContext();
  const roleId = await systemRoleId(slug, transaction);
  const wanted = new Set(branchIds);
  const current = await UserRole.findAll({ where: { instituteId, userId, roleId }, transaction });
  const have = new Set(current.map((r) => r.branchId));
  const stale = current.filter((r) => r.branchId === null || !wanted.has(r.branchId));
  if (stale.length)
    await UserRole.destroy({ where: { instituteId, id: { [Op.in]: stale.map((r) => r.id) } }, transaction });
  for (const branchId of wanted) {
    if (!have.has(branchId))
      await UserRole.create({ instituteId, userId, roleId, branchId }, { transaction });
    const member = await UserBranch.findOne({ where: { instituteId, userId, branchId }, transaction });
    if (!member) await UserBranch.create({ instituteId, userId, branchId }, { transaction });
  }
  // Drop branch memberships no role refers to any more (staff memberships keep their roles).
  for (const r of stale) {
    if (r.branchId === null || wanted.has(r.branchId)) continue;
    const remaining = await UserRole.count({
      where: { instituteId, userId, branchId: r.branchId },
      transaction,
    });
    if (!remaining)
      await UserBranch.destroy({ where: { instituteId, userId, branchId: r.branchId }, transaction });
  }
}
