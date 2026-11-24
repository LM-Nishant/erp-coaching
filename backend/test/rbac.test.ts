import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '@erp/shared';
import { discoverModules } from '../src/infrastructure/module-loader';
import { Branch } from '../src/modules/branches/branch.model';
import { syncPermissionCatalog } from '../src/modules/permissions/catalog.service';
import { Permission, Role, RolePermission } from '../src/modules/permissions/models';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

describe('RBAC', () => {
  let admin: string;
  let teacher: string;
  let branchAdmin: string;

  beforeAll(async () => {
    await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    branchAdmin = (await login(USERS.apexBranchAdmin)).accessToken;
  });

  it('teacher can view branches but not create them', async () => {
    const app = await getApp();
    expect((await request(app).get('/api/branches').set(bearer(teacher))).status).toBe(200);
    const res = await request(app).post('/api/branches').set(bearer(teacher)).send({ name: 'X', code: 'XX' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('members without branches.view list their branches without contact details', async () => {
    const app = await getApp();
    const student = (await login({ mobile: '9100000005', password: DEMO_PASSWORD })).accessToken;
    const me = await request(app).get('/api/auth/me').set(bearer(student));
    expect(me.body.permissions).not.toContain('branches.view');
    const res = await request(app).get('/api/branches').set(bearer(student));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const b of res.body) expect(Object.keys(b).sort()).toEqual(['code', 'id', 'name', 'status']);
    const full = await request(app).get('/api/branches').set(bearer(teacher));
    expect(full.body[0]).toHaveProperty('address');
    expect((await request(app).get(`/api/branches/${res.body[0].id}`).set(bearer(student))).status).toBe(403);
  });

  it('branch admin only sees assigned branches', async () => {
    const res = await request(await getApp())
      .get('/api/branches')
      .set(bearer(branchAdmin));
    expect(res.body).toHaveLength(1);
    const other = await Branch.findOne({ where: { instituteId: 1, code: 'B2' } });
    expect(
      (
        await request(await getApp())
          .get(`/api/branches/${other!.id}`)
          .set(bearer(branchAdmin))
      ).status,
    ).toBe(403);
  });

  it('custom role grants exactly its permissions', async () => {
    const app = await getApp();
    const role = await request(app)
      .post('/api/roles')
      .set(bearer(admin))
      .send({ name: 'Front Desk', permissions: ['branches.view', 'users.view'] });
    expect(role.status).toBe(201);

    const created = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({
        name: 'Desk Person',
        mobile: '9100000099',
        password: 'Password@123',
        roles: [{ roleId: role.body.id, branchId: null }],
      });
    expect(created.status).toBe(201);

    const desk = (await login({ mobile: '9100000099', password: 'Password@123' })).accessToken;
    const me = await request(app).get('/api/auth/me').set(bearer(desk));
    expect(me.body.permissions.sort()).toEqual(['branches.view', 'users.view']);
    expect((await request(app).get('/api/users').set(bearer(desk))).status).toBe(200);
    expect(
      (await request(app).post('/api/roles').set(bearer(desk)).send({ name: 'Y', permissions: [] })).status,
    ).toBe(403);
  });

  it('system roles cannot be edited by institutes', async () => {
    const app = await getApp();
    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const teacherRole = roles.body.find((r: { slug: string }) => r.slug === 'teacher');
    const res = await request(app)
      .put(`/api/roles/${teacherRole.id}`)
      .set(bearer(admin))
      .send({ name: 'Teacher Plus', permissions: [] });
    expect(res.status).toBe(404);
  });

  it('super admin routes are closed to institute users', async () => {
    expect(
      (
        await request(await getApp())
          .get('/api/admin/institutes')
          .set(bearer(admin))
      ).status,
    ).toBe(403);
  });

  describe('system role grants', () => {
    const SELF_SERVICE = [
      'student-portal.view',
      'guardian-portal.view',
      'parent-portal.view',
      'my-fees.view',
      'attendance-self.create',
      'exam-portal.view',
      'appointments.create',
    ];
    const grantsOf = async (slug: string) => {
      const role = await Role.findOne({
        where: { instituteId: null, slug },
        include: [{ model: Permission, as: 'permissions' }],
      });
      return new Set(role!.permissions!.map((p) => p.key));
    };

    it('leave student and parent self-service out of the institute admin blanket grant', async () => {
      const [instituteAdmin, student, parent] = await Promise.all(
        [SYSTEM_ROLES.INSTITUTE_ADMIN, SYSTEM_ROLES.STUDENT, SYSTEM_ROLES.PARENT].map(grantsOf),
      );
      expect(SELF_SERVICE.filter((k) => instituteAdmin.has(k))).toEqual([]);
      expect(SELF_SERVICE.filter((k) => !student.has(k) && !parent.has(k))).toEqual([]);
      const management = [
        'parent-portal.configure',
        'appointments.configure',
        'students.view',
        'fees.approve',
      ];
      expect(management.filter((k) => !instituteAdmin.has(k))).toEqual([]);
    });

    it('keep institute admins out of the parent portal API', async () => {
      const app = await getApp();
      const parent = (await login({ mobile: '9100000006', password: DEMO_PASSWORD })).accessToken;
      expect((await request(app).get('/api/guardian-portal/children').set(bearer(parent))).status).toBe(200);
      const res = await request(app).get('/api/guardian-portal/children').set(bearer(admin));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    });

    it('drop self-service grants an existing database gave institute admins when re-synced', async () => {
      const [role, perm] = await Promise.all([
        Role.findOne({ where: { instituteId: null, slug: SYSTEM_ROLES.INSTITUTE_ADMIN } }),
        Permission.findOne({ where: { key: 'my-fees.view' } }),
      ]);
      const stale = { roleId: role!.id, permissionId: perm!.id };
      await RolePermission.bulkCreate([stale], { ignoreDuplicates: true });
      try {
        await syncPermissionCatalog(await discoverModules());
        expect(await RolePermission.count({ where: stale })).toBe(0);
      } finally {
        await RolePermission.destroy({ where: stale });
      }
    });
  });
});
