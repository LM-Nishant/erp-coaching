import { Op } from 'sequelize';
import {
  PERMISSION_ACTIONS,
  PERMISSION_AREAS,
  SYSTEM_ROLES,
  type PermissionAccess,
  type PermissionAction,
  type PermissionCatalogEntry,
  type PermissionKey,
  type SystemRoleSlug,
} from '@erp/shared';
import type { ModuleDefinition, PermissionDeclaration } from '../../shared/module';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Permission, Role, RolePermission } from './models';

export const SYSTEM_ROLE_DEFS: Record<SystemRoleSlug, { name: string; description: string }> = {
  [SYSTEM_ROLES.SUPER_ADMIN]: {
    name: 'Super Admin',
    description: 'SaaS platform administrator (flag on user)',
  },
  [SYSTEM_ROLES.INSTITUTE_ADMIN]: { name: 'Institute Admin', description: 'Full control of one institute' },
  [SYSTEM_ROLES.BRANCH_ADMIN]: { name: 'Branch Admin', description: 'Manages assigned branches' },
  [SYSTEM_ROLES.ACCOUNTANT]: { name: 'Accountant', description: 'Fees, receipts, expenses, finance reports' },
  [SYSTEM_ROLES.TEACHER]: { name: 'Teacher', description: 'Classes, attendance, content, exams' },
  [SYSTEM_ROLES.STUDENT]: { name: 'Student', description: 'Learner' },
  [SYSTEM_ROLES.PARENT]: { name: 'Parent', description: 'Guardian of linked students' },
};

const flagged = (flag: true | readonly PermissionAction[] | undefined, action: PermissionAction) =>
  flag === true || (flag ?? []).includes(action);

function accessOf(d: PermissionDeclaration, action: PermissionAction): PermissionAccess {
  if (flagged(d.adminOnly, action)) return 'admin-only';
  if (flagged(d.selfService, action)) return 'self-service';
  return 'any';
}

/**
 * The role editor's catalog: every declared permission with its text and who may hold it, by area
 * (`PERMISSION_AREAS` order), then module declaration order, then `PERMISSION_ACTIONS` order.
 */
export function permissionCatalog(modules: ModuleDefinition[]): PermissionCatalogEntry[] {
  const decls = modules.flatMap((m) => m.permissions ?? []);
  return PERMISSION_AREAS.flatMap((area) =>
    decls
      .filter((d) => d.area === area)
      .flatMap((d) =>
        PERMISSION_ACTIONS.filter((a) => d.actions.includes(a)).map((action) => {
          const [label, description] = d.describe[action] ?? [`${d.label}: ${action}`, ''];
          return {
            key: `${d.module}.${action}` as PermissionKey,
            module: d.module,
            action,
            area,
            moduleLabel: d.label,
            label,
            description,
            access: accessOf(d, action),
          };
        }),
      ),
  );
}

/** Keys custom roles cannot hold: admin-only and self-service permissions. */
export function nonGrantableKeys(modules: ModuleDefinition[]): Set<string> {
  return new Set(
    permissionCatalog(modules)
      .filter((p) => p.access !== 'any')
      .map((p) => p.key),
  );
}

/** Keys only the Institute Admin system role holds. */
export function adminOnlyKeys(modules: ModuleDefinition[]): Set<string> {
  return new Set(
    permissionCatalog(modules)
      .filter((p) => p.access === 'admin-only')
      .map((p) => p.key),
  );
}

/**
 * Upserts the permission catalog declared by modules and the system role templates with their
 * default grants. Idempotent; runs at boot and from the seeder. Institute Admin receives every
 * permission except self-service ones (`PermissionDeclaration.selfService`) not granted to it
 * explicitly. Grants a system role no longer has are deleted, so existing databases follow suit.
 */
export async function syncPermissionCatalog(modules: ModuleDefinition[]): Promise<void> {
  const decls = modules.flatMap((m) => m.permissions ?? []);
  await getSequelize().transaction(async (transaction) => {
    const rows = decls.flatMap((d) =>
      d.actions.map((action) => ({
        module: d.module,
        action,
        key: `${d.module}.${action}`,
        label: `${d.label}: ${action}`,
      })),
    );
    for (const action of rows.map((r) => r.action)) {
      if (!(PERMISSION_ACTIONS as readonly string[]).includes(action))
        throw new Error(`Unknown permission action ${action}`);
    }
    for (const d of decls) {
      for (const [slug, grant] of Object.entries(d.grants ?? {})) {
        const actions = grant === 'all' ? d.actions : (grant ?? []);
        const leaked = actions.filter((a) => flagged(d.adminOnly, a));
        if (leaked.length)
          throw new Error(`${d.module}.${leaked[0]} is admin-only; ${slug} cannot be granted it`);
      }
    }
    if (rows.length) {
      await Permission.bulkCreate(rows, { updateOnDuplicate: ['label', 'module', 'action'], transaction });
    }
    const perms = await Permission.findAll({ transaction });
    const byKey = new Map(perms.map((p) => [p.key, p.id]));
    const selfService = new Set(
      decls.flatMap((d) =>
        (d.selfService === true ? d.actions : (d.selfService ?? [])).map((a) => `${d.module}.${a}`),
      ),
    );

    for (const [slug, def] of Object.entries(SYSTEM_ROLE_DEFS) as [
      SystemRoleSlug,
      { name: string; description: string },
    ][]) {
      let role = await Role.findOne({ where: { instituteId: null, slug }, transaction });
      if (!role)
        role = await Role.create({ instituteId: null, slug, isSystem: true, ...def }, { transaction });
      else await role.update(def, { transaction });

      const keys = new Set<string>();
      if (slug === SYSTEM_ROLES.INSTITUTE_ADMIN) {
        for (const p of perms) if (!selfService.has(p.key)) keys.add(p.key);
      }
      for (const d of decls) {
        const grant = d.grants?.[slug];
        if (!grant) continue;
        const actions = grant === 'all' ? d.actions : grant;
        actions.forEach((a) => keys.add(`${d.module}.${a}`));
      }
      const ids = [...keys].map((k) => byKey.get(k)).filter((x): x is number => !!x);
      await RolePermission.destroy({
        where: { roleId: role.id, ...(ids.length ? { permissionId: { [Op.notIn]: ids } } : {}) },
        transaction,
      });
      if (ids.length) {
        await RolePermission.bulkCreate(
          ids.map((permissionId) => ({ roleId: role!.id, permissionId })),
          { ignoreDuplicates: true, transaction },
        );
      }
    }
  });
}

export async function getSystemRole(slug: SystemRoleSlug): Promise<Role> {
  const role = await Role.findOne({ where: { instituteId: null, slug } });
  if (!role) throw new Error(`System role ${slug} missing; run migrations/seeders`);
  return role;
}
