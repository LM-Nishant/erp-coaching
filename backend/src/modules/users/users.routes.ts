import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import type { DeviceUserDto } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission } from '../../shared/middleware/authorize';
import { requireTenantContext, type TenantContext } from '../../shared/context';
import { BadRequest, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { Branch } from '../branches/branch.model';
import { Role, UserBranch, UserRole } from '../permissions/models';
import { assertMemberInBranchScope, memberVisibilityWhere } from '../permissions/access.service';
import { Device, listUserDevices, revokeDevice } from '../authentication/api';
import { User } from './user.model';

const assignmentSchema = z.object({
  roles: z
    .array(
      z.object({
        roleId: z.number().int().positive(),
        branchId: z.number().int().positive().nullable().default(null),
      }),
    )
    .min(1),
  branchIds: z.array(z.number().int().positive()).default([]),
});

/** Validates roles/branches belong to the tenant and that the actor may grant them. */
async function validateAssignment(input: z.infer<typeof assignmentSchema>) {
  const { instituteId, allowedBranchIds } = requireTenantContext();
  const roleIds = [...new Set(input.roles.map((r) => r.roleId))];
  const roles = await Role.findAll({ where: { id: roleIds, instituteId: { [Op.or]: [null, instituteId] } } });
  if (roles.length !== roleIds.length) throw BadRequest('Unknown role');
  if (roles.some((r) => r.slug === 'super-admin')) throw Forbidden('Super admin cannot be assigned here');
  const branchIds = [
    ...new Set([
      ...input.branchIds,
      ...input.roles.map((r) => r.branchId).filter((b): b is number => b !== null),
    ]),
  ];
  if (branchIds.length) {
    const count = await Branch.count({ where: { instituteId, id: branchIds } });
    if (count !== branchIds.length) throw BadRequest('Unknown branch');
  }
  if (allowedBranchIds !== null) {
    if (input.roles.some((r) => r.branchId === null))
      throw Forbidden('Branch-restricted users cannot grant institute-wide roles');
    if (branchIds.some((b) => !allowedBranchIds.includes(b)))
      throw Forbidden('Branch not accessible', 'BRANCH_FORBIDDEN');
  }
}

async function replaceAssignments(userId: number, input: z.infer<typeof assignmentSchema>) {
  const { instituteId } = requireTenantContext();
  await getSequelize().transaction(async (transaction) => {
    await UserRole.destroy({ where: { instituteId, userId }, transaction });
    await UserBranch.destroy({ where: { instituteId, userId }, transaction });
    const unique = new Map(input.roles.map((r) => [`${r.roleId}:${r.branchId}`, r]));
    await UserRole.bulkCreate(
      [...unique.values()].map((r) => ({ userId, instituteId, roleId: r.roleId, branchId: r.branchId })),
      { transaction },
    );
    if (input.branchIds.length) {
      await UserBranch.bulkCreate(
        [...new Set(input.branchIds)].map((branchId) => ({ userId, instituteId, branchId })),
        { transaction },
      );
    }
  });
}

async function memberOrThrow(userId: number, mode: 'read' | 'manage' = 'read') {
  const { instituteId } = requireTenantContext();
  const roles = await UserRole.findAll({
    where: { instituteId, userId },
    include: [{ model: Role, as: 'role' }],
  });
  if (!roles.length) throw NotFound('User');
  await assertMemberInBranchScope(userId, mode);
  return roles;
}

const isPlatformAdmin = (ctx: TenantContext) => !!ctx.isSuperAdmin && !ctx.impersonatorId;

/**
 * A member whose sign-in devices the requester may manage (spec 4.18), with the same branch rule as
 * role changes: branch-scoped admins only manage members whose access lies wholly within their own
 * branches (`assertMemberInBranchScope`). Super admin accounts are managed by the platform only.
 */
async function manageableMember(userId: number) {
  const ctx = requireTenantContext();
  await memberOrThrow(userId, 'manage');
  const user = await User.findByPk(userId);
  if (!user || (user.isSuperAdmin && !isPlatformAdmin(ctx))) throw NotFound('User');
  return user;
}

/** Ids of members limited to the requester's branches, or null when the requester is institute-wide. */
async function branchMemberIds(ctx: TenantContext): Promise<number[] | null> {
  if (ctx.allowedBranchIds === null) return null;
  const { instituteId, allowedBranchIds: branchId } = ctx;
  const [roles, branches, instituteWide] = await Promise.all([
    UserRole.findAll({ where: { instituteId, branchId }, attributes: ['userId'] }),
    UserBranch.findAll({ where: { instituteId, branchId }, attributes: ['userId'] }),
    UserRole.findAll({ where: { instituteId, branchId: null }, attributes: ['userId'] }),
  ]);
  const excluded = new Set(instituteWide.map((r) => r.userId));
  return [...new Set([...roles, ...branches].map((r) => r.userId))].filter((id) => !excluded.has(id));
}

/** Device management search: members the requester may manage, with their active device count. */
async function searchDeviceUsers(search?: string): Promise<DeviceUserDto[]> {
  const ctx = requireTenantContext();
  const ids = await branchMemberIds(ctx);
  if (ids && !ids.length) return [];
  const where: WhereOptions[] = [];
  if (ids) where.push({ id: ids });
  if (!isPlatformAdmin(ctx)) where.push({ isSuperAdmin: false });
  if (search)
    where.push({
      [Op.or]: [
        { name: { [Op.like]: `%${search}%` } },
        { mobile: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
      ],
    });
  const users = await User.findAll({
    where: { [Op.and]: where },
    include: [
      { model: UserRole, as: 'roleAssignments', where: { instituteId: ctx.instituteId }, attributes: [] },
    ],
    order: [['name', 'ASC']],
    limit: 50,
    subQuery: false,
  });
  if (!users.length) return [];
  const unique = [...new Map(users.map((u) => [u.id, u])).values()];
  const devices = await Device.findAll({
    where: { userId: unique.map((u) => u.id), status: 'active' },
    attributes: ['userId'],
  });
  return unique.map((u) => ({
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    email: u.email,
    status: u.status,
    activeDevices: devices.filter((d) => d.userId === u.id).length,
  }));
}

export function userRoutes(api: Router) {
  const r = Router();
  r.use(authenticate);

  r.get('/', requirePermission('users', 'view'), async (req, res) => {
    const q = parse(paginationSchema.extend({ role: z.string().optional() }), req.query);
    const { instituteId } = requireTenantContext();
    const search = q.search
      ? {
          [Op.or]: [
            { name: { [Op.like]: `%${q.search}%` } },
            { mobile: { [Op.like]: `%${q.search}%` } },
            { email: { [Op.like]: `%${q.search}%` } },
          ],
        }
      : undefined;
    const visible = memberVisibilityWhere();
    const userWhere = search && visible ? { [Op.and]: [search, visible] } : (search ?? visible);
    const { rows, count } = await User.findAndCountAll({
      where: userWhere,
      include: [
        {
          model: UserRole,
          as: 'roleAssignments',
          where: { instituteId },
          include: [{ model: Role, as: 'role', ...(q.role ? { where: { slug: q.role } } : {}) }],
        },
      ],
      distinct: true,
      order: [['name', 'ASC']],
      ...toLimitOffset(q),
    });
    res.json(
      paginated(
        rows.map((u) => ({
          ...u.toPublic(),
          roles: ((u as unknown as { roleAssignments: UserRole[] }).roleAssignments ?? []).map((a) => ({
            roleId: a.roleId,
            slug: a.role?.slug,
            name: a.role?.name,
            branchId: a.branchId,
          })),
        })),
        count,
        q,
      ),
    );
  });

  r.post('/', requirePermission('users', 'create'), async (req, res) => {
    const body = parse(
      assignmentSchema.extend({
        name: z.string().trim().min(2).max(150),
        mobile: z
          .string()
          .trim()
          .regex(/^\+?\d{10,15}$/),
        email: z.string().email().optional(),
        password: z.string().min(8).max(200).optional(),
      }),
      req.body,
    );
    await validateAssignment(body);
    const { instituteId } = requireTenantContext();
    let user = await User.findOne({ where: { mobile: body.mobile } });
    if (user) {
      const existing = await UserRole.count({ where: { instituteId, userId: user.id } });
      if (existing) throw BadRequest('User is already a member of this institute');
    } else {
      user = await User.create({
        name: body.name,
        mobile: body.mobile,
        email: body.email ?? null,
        passwordHash: body.password ? await bcrypt.hash(body.password, 10) : null,
        lastLoginAt: null,
      });
    }
    await replaceAssignments(user.id, body);
    await audit({
      action: 'user.added_to_institute',
      entityType: 'user',
      entityId: user.id,
      metadata: { roles: body.roles, branchIds: body.branchIds },
    });
    res.status(201).json(user.toPublic());
  });

  r.get('/devices', requirePermission('users', 'view'), async (req, res) => {
    const q = parse(z.object({ search: z.string().trim().max(100).optional() }), req.query);
    res.json(await searchDeviceUsers(q.search || undefined));
  });

  r.get('/:id', requirePermission('users', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const roles = await memberOrThrow(id);
    const { instituteId } = requireTenantContext();
    const [user, branches] = await Promise.all([
      User.findByPk(id),
      UserBranch.findAll({ where: { instituteId, userId: id } }),
    ]);
    res.json({
      ...user!.toPublic(),
      roles: roles.map((a) => ({
        roleId: a.roleId,
        slug: a.role?.slug,
        name: a.role?.name,
        branchId: a.branchId,
      })),
      branchIds: branches.map((b) => b.branchId),
    });
  });

  r.put('/:id/roles', requirePermission('users', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(assignmentSchema, req.body);
    const before = await memberOrThrow(id, 'manage');
    if (id === req.ctx.userId) throw Forbidden('You cannot change your own roles');
    await validateAssignment(body);
    await replaceAssignments(id, body);
    await audit({
      action: 'user.roles_changed',
      entityType: 'user',
      entityId: id,
      metadata: { before: before.map((b) => ({ roleId: b.roleId, branchId: b.branchId })), after: body },
    });
    res.json({ ok: true });
  });

  r.delete('/:id', requirePermission('users', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await memberOrThrow(id, 'manage');
    if (id === req.ctx.userId) throw Forbidden('You cannot remove yourself');
    const { instituteId } = requireTenantContext();
    await UserRole.destroy({ where: { instituteId, userId: id } });
    await UserBranch.destroy({ where: { instituteId, userId: id } });
    await audit({ action: 'user.removed_from_institute', entityType: 'user', entityId: id });
    res.status(204).end();
  });

  r.get('/:id/devices', requirePermission('users', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await manageableMember(id);
    res.json(await listUserDevices(id));
  });

  // Revoking signs the device out at once (tokens), wipes its offline downloads and biometric
  // unlock, notifies the user and is audited (see authentication/devices.service).
  r.delete('/:id/devices/:deviceId', requirePermission('users', 'edit'), async (req, res) => {
    const p = parse(
      z.object({ id: z.coerce.number().int().positive(), deviceId: z.coerce.number().int().positive() }),
      req.params,
    );
    await manageableMember(p.id);
    await revokeDevice(p.deviceId, p.id, req.ctx.userId!);
    res.status(204).end();
  });

  api.use('/users', r);
}
