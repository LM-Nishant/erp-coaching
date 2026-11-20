import { Router } from 'express';
import { fn, col, Op } from 'sequelize';
import { z } from 'zod';
import type { PermissionKey, RoleDto } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { discoverModules } from '../../infrastructure/module-loader';
import { nonGrantableKeys, permissionCatalog } from './catalog.service';
import { memberVisibilityWhere } from './access.service';
import { Permission, Role, RolePermission, UserRole } from './models';

const roleBody = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(255).nullable().optional(),
  permissions: z.array(z.string().regex(/^[a-z0-9-]+\.[a-z]+$/)).max(1000),
});

function serialize(role: Role, memberCount = 0, permissions?: string[]): RoleDto {
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: (permissions ?? (role.permissions ?? []).map((p) => p.key)) as PermissionKey[],
    memberCount,
  };
}

/** Permission ids for a custom role; admin-only and self-service keys are refused. */
async function permissionIds(keys: string[]) {
  const locked = nonGrantableKeys(await discoverModules());
  const refused = [...new Set(keys)].filter((k) => locked.has(k));
  if (refused.length)
    throw new AppError(
      400,
      'PERMISSION_NOT_GRANTABLE',
      'Custom roles cannot include permissions only the Institute Admin, students or parents hold',
      { keys: refused },
    );
  const perms = await Permission.findAll({ where: { key: keys } });
  if (perms.length !== new Set(keys).size) throw BadRequest('Unknown permission key');
  return perms.map((p) => p.id);
}

/** Members holding each role, counted among the members the caller can see. */
async function memberCounts(instituteId: number): Promise<Map<number, number>> {
  const visible = memberVisibilityWhere() as { id?: unknown } | undefined;
  const rows = (await UserRole.findAll({
    attributes: ['roleId', [fn('COUNT', fn('DISTINCT', col('user_id'))), 'members']],
    where: { instituteId, ...(visible?.id ? { userId: visible.id } : {}) },
    group: ['roleId'],
    raw: true,
  })) as unknown as { roleId: number; members: number | string }[];
  return new Map(rows.map((r) => [r.roleId, Number(r.members)]));
}

/** 409 when another role of the institute (or a system role) already has this name. */
async function assertNameFree(instituteId: number, name: string, exceptId?: number) {
  const clash = await Role.findOne({
    where: {
      instituteId: { [Op.or]: [null, instituteId] },
      name,
      ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
    },
  });
  if (clash) throw Conflict('A role with this name exists', 'ROLE_NAME_TAKEN');
}

async function uniqueSlug(instituteId: number, name: string) {
  const base = `custom-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`.slice(0, 54);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!(await Role.findOne({ where: { instituteId, slug } }))) return slug;
  }
}

async function ownCustomRole(id: number) {
  const { instituteId } = requireTenantContext();
  const role = await Role.findOne({ where: { id, instituteId } });
  if (!role) throw NotFound('Role');
  return role;
}

export function roleRoutes(api: Router) {
  const permissionsRouter = Router();
  permissionsRouter.use(authenticate);
  const r = Router();
  r.use(authenticate);

  permissionsRouter.get('/', requirePermission('roles', 'view'), async (_req, res) => {
    res.json(permissionCatalog(await discoverModules()));
  });

  r.get('/', requirePermission('roles', 'view'), async (_req, res) => {
    const { instituteId } = requireTenantContext();
    const roles = await Role.findAll({
      where: { instituteId: { [Op.or]: [null, instituteId] }, slug: { [Op.ne]: 'super-admin' } },
      include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }],
      order: [
        ['isSystem', 'DESC'],
        ['name', 'ASC'],
      ],
    });
    const counts = await memberCounts(instituteId);
    res.json(roles.map((role) => serialize(role, counts.get(role.id) ?? 0)));
  });

  r.post('/', requirePermission('roles', 'create'), async (req, res) => {
    const body = parse(roleBody, req.body);
    const { instituteId } = requireTenantContext();
    await assertNameFree(instituteId, body.name);
    const ids = await permissionIds(body.permissions);
    const slug = await uniqueSlug(instituteId, body.name);
    const role = await getSequelize().transaction(async (transaction) => {
      const role = await Role.create(
        { instituteId, slug, name: body.name, description: body.description ?? null, isSystem: false },
        { transaction },
      );
      await RolePermission.bulkCreate(
        ids.map((permissionId) => ({ roleId: role.id, permissionId })),
        { transaction },
      );
      return role;
    });
    await audit({
      action: 'role.created',
      entityType: 'role',
      entityId: role.id,
      branchId: null,
      metadata: { name: role.name, permissions: body.permissions },
    });
    res.status(201).json(serialize(role, 0, body.permissions));
  });

  r.put('/:id', requirePermission('roles', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(roleBody, req.body);
    const role = await ownCustomRole(id);
    await assertNameFree(role.instituteId!, body.name, role.id);
    const ids = await permissionIds(body.permissions);
    const before = (
      await Permission.findAll({
        include: [{ model: Role, as: 'roles', where: { id: role.id }, attributes: [] }],
      })
    ).map((p) => p.key);
    const beforeName = role.name;
    await getSequelize().transaction(async (transaction) => {
      await role.update({ name: body.name, description: body.description ?? null }, { transaction });
      await RolePermission.destroy({ where: { roleId: role.id }, transaction });
      await RolePermission.bulkCreate(
        ids.map((permissionId) => ({ roleId: role.id, permissionId })),
        { transaction },
      );
    });
    await audit({
      action: 'role.permissions_changed',
      entityType: 'role',
      entityId: id,
      branchId: null,
      metadata: {
        before: { name: beforeName, permissions: before },
        after: { name: body.name, permissions: body.permissions },
      },
    });
    const counts = await memberCounts(role.instituteId!);
    res.json(serialize(role, counts.get(role.id) ?? 0, body.permissions));
  });

  r.delete('/:id', requirePermission('roles', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const role = await ownCustomRole(id);
    const { instituteId } = requireTenantContext();
    if (await UserRole.count({ where: { instituteId, roleId: id } }))
      throw Forbidden('Role is assigned to users', 'ROLE_IN_USE');
    await role.destroy();
    await audit({
      action: 'role.deleted',
      entityType: 'role',
      entityId: id,
      branchId: null,
      metadata: { name: role.name },
    });
    res.status(204).end();
  });

  api.use('/permissions', permissionsRouter);
  api.use('/roles', r);
}
