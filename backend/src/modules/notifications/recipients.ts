import { Op } from 'sequelize';
import type { CampaignAudience, RecipientType } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { BadRequest } from '../../shared/errors';
import { logger } from '../../infrastructure/logger';
import { Role, UserBranch, UserRole } from '../permissions/models';

/**
 * A recipient in a `notify()` call:
 * - a user id, or `{ userIds, type? }` (type defaults to `user`);
 * - `{ role: 'teacher', branchId? }`: every member holding the role (role `student` → type `student`,
 *   `parent` → `guardian`, others → `staff`);
 * - `{ resolver, args, type }`: ids returned by a resolver another module registered, e.g.
 *   `guardiansOf(studentId)`.
 */
export type RecipientSpec =
  | number
  | { userIds: number[]; type?: RecipientType }
  | { role: string; branchId?: number }
  | { resolver: string; args: unknown; type: RecipientType };

export type RecipientResolver = (args: unknown, ctx: { instituteId: number }) => Promise<number[]>;

const resolvers = new Map<string, RecipientResolver>();

/**
 * Lets the owning module translate domain ids into user ids, e.g. the students module registers
 * `guardiansOf` (student id → parent user ids) and `studentUser`; batches registers `batchMembers`.
 */
export function registerRecipientResolver(name: string, fn: RecipientResolver): void {
  resolvers.set(name, fn);
}

export function hasRecipientResolver(name: string): boolean {
  return resolvers.has(name);
}

/** Parents/guardians of a student (resolver registered by the students module). */
export const guardiansOf = (studentId: number): RecipientSpec => ({
  resolver: 'guardiansOf',
  args: studentId,
  type: 'guardian',
});

/** The login user of a student record (resolver registered by the students module). */
export const studentUserOf = (studentId: number): RecipientSpec => ({
  resolver: 'studentUser',
  args: studentId,
  type: 'student',
});

function typeForRole(slug: string): RecipientType {
  if (slug === 'student') return 'student';
  if (slug === 'parent') return 'guardian';
  return 'staff';
}

/** User ids holding one of the roles (optionally within branches) in the current institute. */
async function usersWithRoles(
  instituteId: number,
  slugs: string[],
  branchIds?: number[],
): Promise<{ userId: number; slug: string }[]> {
  const roles = await Role.findAll({
    where: { slug: slugs, [Op.or]: [{ instituteId: null }, { instituteId }] },
  });
  if (!roles.length) return [];
  const slugById = new Map(roles.map((r) => [r.id, r.slug]));
  const where: Record<string | symbol, unknown> = { instituteId, roleId: [...slugById.keys()] };
  if (branchIds?.length) {
    const members = await UserBranch.findAll({ where: { instituteId, branchId: branchIds } });
    where[Op.or] = [{ branchId: branchIds }, { userId: members.map((m) => m.userId) }];
  }
  const rows = await UserRole.findAll({ where });
  return rows.map((r) => ({ userId: r.userId, slug: slugById.get(r.roleId)! }));
}

/** Resolves recipient specs to `userId → types`, limited to members of the current institute. */
export async function resolveRecipients(specs: RecipientSpec[]): Promise<Map<number, Set<RecipientType>>> {
  const { instituteId } = requireTenantContext();
  const out = new Map<number, Set<RecipientType>>();
  const add = (userId: number, type: RecipientType) => {
    if (!Number.isInteger(userId) || userId <= 0) return;
    if (!out.has(userId)) out.set(userId, new Set());
    out.get(userId)!.add(type);
  };

  for (const spec of specs) {
    if (typeof spec === 'number') add(spec, 'user');
    else if ('userIds' in spec) spec.userIds.forEach((id) => add(id, spec.type ?? 'user'));
    else if ('role' in spec) {
      const rows = await usersWithRoles(
        instituteId,
        [spec.role],
        spec.branchId ? [spec.branchId] : undefined,
      );
      rows.forEach((r) => add(r.userId, typeForRole(r.slug)));
    } else {
      const fn = resolvers.get(spec.resolver);
      if (!fn) {
        logger.warn(`notify(): no recipient resolver "${spec.resolver}" registered; recipients skipped`);
        continue;
      }
      (await fn(spec.args, { instituteId })).forEach((id) => add(id, spec.type));
    }
  }
  return restrictToMembers(instituteId, out);
}

async function restrictToMembers<T>(instituteId: number, map: Map<number, T>): Promise<Map<number, T>> {
  if (!map.size) return map;
  const members = await UserRole.findAll({
    where: { instituteId, userId: [...map.keys()] },
    attributes: ['userId'],
  });
  const allowed = new Set(members.map((m) => m.userId));
  return new Map([...map].filter(([id]) => allowed.has(id)));
}

/** Bulk/scheduled audience (branch / batch / role / explicit users) → userId → type. */
export async function resolveAudience(audience: CampaignAudience): Promise<Map<number, RecipientType>> {
  const { instituteId } = requireTenantContext();
  const out = new Map<number, RecipientType>();
  const branchIds = audience.branchIds?.length ? audience.branchIds : undefined;

  if (audience.roles?.length) {
    for (const r of await usersWithRoles(instituteId, audience.roles, branchIds))
      if (!out.has(r.userId)) out.set(r.userId, typeForRole(r.slug));
  } else if (branchIds && !audience.batchIds?.length && !audience.userIds?.length) {
    // Branch only: everyone with a role or membership in the branch.
    const roles = await Role.findAll({ attributes: ['slug'] });
    const slugs = [...new Set(roles.map((r) => r.slug))];
    for (const r of await usersWithRoles(instituteId, slugs, branchIds))
      if (!out.has(r.userId)) out.set(r.userId, typeForRole(r.slug));
  }

  if (audience.batchIds?.length) {
    const fn = resolvers.get('batchMembers');
    if (!fn) throw BadRequest('Batch audiences are not available until the batches module is installed');
    for (const batchId of audience.batchIds)
      for (const id of await fn(batchId, { instituteId })) if (!out.has(id)) out.set(id, 'student');
  }

  audience.userIds?.forEach((id) => out.has(id) || out.set(id, 'user'));
  return restrictToMembers(instituteId, out);
}
