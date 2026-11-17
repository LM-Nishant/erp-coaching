import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { idParam } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Permission, Role, RolePermission, UserRole } from './models';

const roleBody = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(255).nullable().optional(),
  permissions: z.array(z.string().regex(/^[a-z0-9-]+\.[a-z]+$/)).max(1000),
});

function serialize(role: Role) {
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: (role.permissions ?? []).map((p) => p.key),
  };
}

async function permissionIds(keys: string[]) {
  const perms = await Permission.findAll({ where: { key: keys } });
  if (perms.length !== new Set(keys).size) throw BadRequest('Unknown permission key');
  return perms.map((p) => p.id);
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
    const perms = await Permission.findAll({
      order: [
        ['module', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const grouped: Record<string, { key: string; action: string; label: string }[]> = {};
    perms.forEach((p) => (grouped[p.module] ??= []).push({ key: p.key, action: p.action, label: p.label }));
    res.json(grouped);
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
    res.json(roles.map(serialize));
  });

  r.post('/', requirePermission('roles', 'create'), async (req, res) => {
    const body = parse(roleBody, req.body);
    const { instituteId } = requireTenantContext();
    const slug = `custom-${body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}`.slice(0, 60);
    if (await Role.findOne({ where: { instituteId, slug } })) throw Conflict('A role with this name exists');
    const ids = await permissionIds(body.permissions);
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
      metadata: { permissions: body.permissions },
    });
    res.status(201).json({ ...serialize(role), permissions: body.permissions });
  });

  r.put('/:id', requirePermission('roles', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(roleBody, req.body);
    const role = await ownCustomRole(id);
    const ids = await permissionIds(body.permissions);
    const before = (await RolePermission.findAll({ where: { roleId: role.id } })).map((p) => p.permissionId);
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
      metadata: { before, after: body.permissions },
    });
    res.json({ ...serialize(role), permissions: body.permissions });
  });

  r.delete('/:id', requirePermission('roles', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const role = await ownCustomRole(id);
    const { instituteId } = requireTenantContext();
    if (await UserRole.count({ where: { instituteId, roleId: id } }))
      throw Forbidden('Role is assigned to users', 'ROLE_IN_USE');
    await role.destroy();
    await audit({ action: 'role.deleted', entityType: 'role', entityId: id, metadata: { name: role.name } });
    res.status(204).end();
  });

  api.use('/permissions', permissionsRouter);
  api.use('/roles', r);
}
