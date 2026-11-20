import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionCatalogEntry, RoleDto } from '@erp/shared';
import { PERMISSION_AREAS } from '@erp/shared';
import { discoverModules } from '../src/infrastructure/module-loader';
import { adminOnlyKeys, nonGrantableKeys } from '../src/modules/permissions/catalog.service';
import {
  type Actor,
  type Tenant,
  PASSWORD,
  createInstitute,
  createSuperAdmin,
  ok,
  purgeInstitutes,
  query,
  send,
  signIn,
} from './security/harness';

/** Roles & permissions screen API: catalog, custom-role rules, member counts, assignment guard. Mobiles 961…. */
const PREFIX = '961';
let n = 0;
const mobile = () => `${PREFIX}${String(n++).padStart(7, '0')}`;

let superAdmin: Actor;
let tenant: Tenant;
let other: Tenant;
let branchAdmin: Actor;
let roles: RoleDto[];
const roleBySlug = (slug: string) => roles.find((r) => r.slug === slug)!;

async function addMember(by: Actor, roleId: number, branchId: number | null) {
  const m = mobile();
  const res = await send(by, 'POST', '/api/users', {
    name: `Roles member ${m}`,
    mobile: m,
    password: PASSWORD,
    roles: [{ roleId, branchId }],
    branchIds: branchId ? [branchId] : [],
  });
  return { res, mobile: m };
}

beforeAll(async () => {
  superAdmin = await createSuperAdmin(mobile());
  const tag = `roles${crypto.randomBytes(3).toString('hex')}`;
  tenant = await createInstitute(superAdmin, {
    slug: tag,
    name: `Roles ${tag}`,
    adminMobile: mobile(),
    label: 'admin',
  });
  other = await createInstitute(superAdmin, {
    slug: `${tag}b`,
    name: `Roles other ${tag}`,
    adminMobile: mobile(),
    label: 'other admin',
  });
  roles = await ok(tenant.admin, 'GET', '/api/roles');
  const added = await addMember(tenant.admin, roleBySlug('branch-admin').id, tenant.mainBranchId);
  expect(added.res.status).toBe(201);
  branchAdmin = await signIn('branch admin', added.mobile, PASSWORD);
}, 120_000);

afterAll(async () => {
  await purgeInstitutes([tenant?.id, other?.id], PREFIX);
});

describe('permission catalog', () => {
  it('labels and describes every declared permission, grouped by area', async () => {
    const catalog: PermissionCatalogEntry[] = await ok(tenant.admin, 'GET', '/api/permissions');
    const keys = await query<{ key: string }>('SELECT `key` FROM permissions');
    expect(catalog.map((p) => p.key).sort()).toEqual(keys.map((k) => k.key).sort());
    for (const p of catalog) {
      expect(p.label, p.key).toBeTruthy();
      expect(p.label, p.key).not.toContain(':');
      expect(p.description, p.key).toMatch(/\S{3}/);
      expect(PERMISSION_AREAS).toContain(p.area);
    }
    const areas = catalog.map((p) => PERMISSION_AREAS.indexOf(p.area));
    expect(areas).toEqual([...areas].sort((a, b) => a - b));
    const modules = await discoverModules();
    const byKey = new Map(catalog.map((p) => [p.key, p.access]));
    for (const key of adminOnlyKeys(modules)) expect(byKey.get(key), key).toBe('admin-only');
    expect(byKey.get('roles.create')).toBe('admin-only');
    expect(byKey.get('student-portal.view')).toBe('self-service');
    expect(byKey.get('hr-self-service.view')).toBe('any');
    expect(byKey.get('fees.approve')).toBe('any');
  });

  it('is behind roles.view', async () => {
    const teacher = await addMember(tenant.admin, roleBySlug('teacher').id, tenant.mainBranchId);
    const actor = await signIn('teacher', teacher.mobile, PASSWORD);
    expect((await send(actor, 'GET', '/api/permissions')).status).toBe(403);
    expect((await send(actor, 'GET', '/api/roles')).status).toBe(403);
  });
});

describe('custom roles', () => {
  it('lists system roles with member counts and descriptions', async () => {
    const list: RoleDto[] = await ok(tenant.admin, 'GET', '/api/roles');
    expect(list.find((r) => r.slug === 'super-admin')).toBeUndefined();
    expect(list.find((r) => r.slug === 'institute-admin')).toMatchObject({ isSystem: true, memberCount: 1 });
    expect(list.find((r) => r.slug === 'branch-admin')!.memberCount).toBe(1);
    expect(list.find((r) => r.slug === 'teacher')!.description).toBeTruthy();
  });

  it('refuses admin-only and self-service permissions', async () => {
    for (const key of ['roles.create', 'institute.configure', 'student-portal.view']) {
      const res = await send(tenant.admin, 'POST', '/api/roles', {
        name: `Locked ${key}`,
        permissions: ['students.view', key],
      });
      expect(res.status, key).toBe(400);
      expect(res.body.error.code).toBe('PERMISSION_NOT_GRANTABLE');
      expect(res.body.error.details.keys).toEqual([key]);
    }
    const locked = nonGrantableKeys(await discoverModules());
    expect(locked.has('fees.approve')).toBe(false);
  });

  it('creates, renames and deletes a role with audit events (institute-wide)', async () => {
    const created: RoleDto = await ok(tenant.admin, 'POST', '/api/roles', {
      name: 'Auditor',
      description: 'Reads the books',
      permissions: ['fees.view', 'audit.view'],
    });
    expect(created).toMatchObject({ isSystem: false, memberCount: 0, slug: 'custom-auditor' });

    const dup = await send(tenant.admin, 'POST', '/api/roles', { name: 'auditor', permissions: [] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ROLE_NAME_TAKEN');
    const system = await send(tenant.admin, 'POST', '/api/roles', { name: 'Teacher', permissions: [] });
    expect(system.body.error.code).toBe('ROLE_NAME_TAKEN');

    // Same name in another institute is fine, and that institute cannot see or touch ours.
    await ok(other.admin, 'POST', '/api/roles', { name: 'Auditor', permissions: [] });
    expect(
      (await send(other.admin, 'PUT', `/api/roles/${created.id}`, { name: 'XY', permissions: [] })).status,
    ).toBe(404);
    expect((await send(other.admin, 'DELETE', `/api/roles/${created.id}`)).status).toBe(404);
    const otherList: RoleDto[] = await ok(other.admin, 'GET', '/api/roles');
    expect(otherList.find((r) => r.id === created.id)).toBeUndefined();

    const updated: RoleDto = await ok(tenant.admin, 'PUT', `/api/roles/${created.id}`, {
      name: 'Finance auditor',
      description: null,
      permissions: ['fees.view', 'fees.export'],
    });
    expect(updated).toMatchObject({ name: 'Finance auditor', description: null });
    expect([...updated.permissions].sort()).toEqual(['fees.export', 'fees.view']);

    // Renaming to its own name is not a clash; to another role's name is.
    expect(
      (
        await send(tenant.admin, 'PUT', `/api/roles/${created.id}`, {
          name: 'Finance auditor',
          permissions: [],
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(tenant.admin, 'PUT', `/api/roles/${created.id}`, { name: 'Accountant', permissions: [] }))
        .body.error.code,
    ).toBe('ROLE_NAME_TAKEN');

    expect((await send(tenant.admin, 'DELETE', `/api/roles/${created.id}`)).status).toBe(204);

    const events = await query<{ action: string; branch_id: number | null; metadata: string }>(
      "SELECT action, branch_id, metadata FROM audit_events WHERE institute_id = ? AND entity_type = 'role' AND entity_id = ? ORDER BY id",
      [tenant.id, String(created.id)],
    );
    expect(events.map((e) => e.action)).toEqual([
      'role.created',
      'role.permissions_changed',
      'role.permissions_changed',
      'role.deleted',
    ]);
    expect(events.every((e) => e.branch_id === null)).toBe(true);
    const change =
      typeof events[1].metadata === 'string' ? JSON.parse(events[1].metadata) : events[1].metadata;
    expect(change.before.name).toBe('Auditor');
    expect([...change.before.permissions].sort()).toEqual(['audit.view', 'fees.view']);
    expect(change.after.name).toBe('Finance auditor');
  });

  it('gives duplicate-looking names distinct slugs', async () => {
    const a: RoleDto = await ok(tenant.admin, 'POST', '/api/roles', { name: 'Desk (A)', permissions: [] });
    const b: RoleDto = await ok(tenant.admin, 'POST', '/api/roles', { name: 'Desk A', permissions: [] });
    expect(a.slug).toBe('custom-desk-a');
    expect(b.slug).toBe('custom-desk-a-2');
  });

  it('counts members and blocks deleting a role in use', async () => {
    const role: RoleDto = await ok(tenant.admin, 'POST', '/api/roles', {
      name: 'Front office',
      permissions: ['students.view'],
    });
    expect((await addMember(tenant.admin, role.id, null)).res.status).toBe(201);
    expect((await addMember(tenant.admin, role.id, tenant.mainBranchId)).res.status).toBe(201);
    const list: RoleDto[] = await ok(tenant.admin, 'GET', '/api/roles');
    expect(list.find((r) => r.id === role.id)!.memberCount).toBe(2);
    const res = await send(tenant.admin, 'DELETE', `/api/roles/${role.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_IN_USE');
  });
});

describe('assigning roles', () => {
  it('stops a branch admin handing out admin-only roles', async () => {
    const res = await addMember(branchAdmin, roleBySlug('institute-admin').id, tenant.mainBranchId);
    expect(res.res.status).toBe(403);
    expect(res.res.body.error.code).toBe('ROLE_ABOVE_YOUR_ACCESS');
    expect(res.res.body.error.message).toBe('Only an Institute Admin can assign the Institute Admin role');
    const teacher = await addMember(branchAdmin, roleBySlug('teacher').id, tenant.mainBranchId);
    expect(teacher.res.status).toBe(201);
  });

  it('lists only staff with kind=staff', async () => {
    const student = await addMember(tenant.admin, roleBySlug('student').id, tenant.mainBranchId);
    expect(student.res.status).toBe(201);
    const all = await ok(tenant.admin, 'GET', '/api/users?pageSize=100');
    const staff = await ok(tenant.admin, 'GET', '/api/users?kind=staff&pageSize=100');
    const mobiles = (page: { items: { mobile: string }[] }) => page.items.map((u) => u.mobile);
    expect(mobiles(all)).toContain(student.mobile);
    expect(mobiles(staff)).not.toContain(student.mobile);
    expect(mobiles(staff)).toContain(branchAdmin.mobile);
    const searched = await ok(tenant.admin, 'GET', `/api/users?kind=staff&search=${branchAdmin.mobile}`);
    expect(mobiles(searched)).toEqual([branchAdmin.mobile]);
  });
});
