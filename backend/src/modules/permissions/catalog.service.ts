import { Op } from 'sequelize';
import { PERMISSION_ACTIONS, SYSTEM_ROLES, type SystemRoleSlug } from '@erp/shared';
import type { ModuleDefinition } from '../../shared/module';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Permission, Role, RolePermission } from './models';

export const SYSTEM_ROLE_DEFS: Record<SystemRoleSlug, { name: string; description: string }> = {
  [SYSTEM_ROLES.SUPER_ADMIN]: { name: 'Super Admin', description: 'SaaS platform administrator (flag on user)' },
  [SYSTEM_ROLES.INSTITUTE_ADMIN]: { name: 'Institute Admin', description: 'Full control of one institute' },
  [SYSTEM_ROLES.BRANCH_ADMIN]: { name: 'Branch Admin', description: 'Manages assigned branches' },
  [SYSTEM_ROLES.ACCOUNTANT]: { name: 'Accountant', description: 'Fees, receipts, expenses, finance reports' },
  [SYSTEM_ROLES.TEACHER]: { name: 'Teacher', description: 'Classes, attendance, content, exams' },
  [SYSTEM_ROLES.STUDENT]: { name: 'Student', description: 'Learner' },
  [SYSTEM_ROLES.PARENT]: { name: 'Parent', description: 'Guardian of linked students' },
};

/**
 * Upserts the permission catalog declared by modules and the system role templates with their
 * default grants. Idempotent; runs at boot and from the seeder. Institute Admin always receives
 * every permission.
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
      if (!(PERMISSION_ACTIONS as readonly string[]).includes(action)) throw new Error(`Unknown permission action ${action}`);
    }
    if (rows.length) {
      await Permission.bulkCreate(rows, { updateOnDuplicate: ['label', 'module', 'action'], transaction });
    }
    const perms = await Permission.findAll({ transaction });
    const byKey = new Map(perms.map((p) => [p.key, p.id]));

    for (const [slug, def] of Object.entries(SYSTEM_ROLE_DEFS) as [SystemRoleSlug, { name: string; description: string }][]) {
      let role = await Role.findOne({ where: { instituteId: null, slug }, transaction });
      if (!role) role = await Role.create({ instituteId: null, slug, isSystem: true, ...def }, { transaction });
      else await role.update(def, { transaction });

      const keys = new Set<string>();
      if (slug === SYSTEM_ROLES.INSTITUTE_ADMIN) perms.forEach((p) => keys.add(p.key));
      for (const d of decls) {
        const grant = d.grants?.[slug];
        if (!grant) continue;
        const actions = grant === 'all' ? d.actions : grant;
        actions.forEach((a) => keys.add(`${d.module}.${a}`));
      }
      const ids = [...keys].map((k) => byKey.get(k)).filter((x): x is number => !!x);
      await RolePermission.destroy({ where: { roleId: role.id, ...(ids.length ? { permissionId: { [Op.notIn]: ids } } : {}) }, transaction });
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
