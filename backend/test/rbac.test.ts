import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Branch } from '../src/modules/branches/branch.model';
import { USERS, bearer, getApp, login } from './helpers';

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

  it('branch admin only sees assigned branches', async () => {
    const res = await request(await getApp()).get('/api/branches').set(bearer(branchAdmin));
    expect(res.body).toHaveLength(1);
    const other = await Branch.findOne({ where: { instituteId: 1, code: 'B2' } });
    expect((await request(await getApp()).get(`/api/branches/${other!.id}`).set(bearer(branchAdmin))).status).toBe(403);
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
      .send({ name: 'Desk Person', mobile: '9100000099', password: 'Password@123', roles: [{ roleId: role.body.id, branchId: null }] });
    expect(created.status).toBe(201);

    const desk = (await login({ mobile: '9100000099', password: 'Password@123' })).accessToken;
    const me = await request(app).get('/api/auth/me').set(bearer(desk));
    expect(me.body.permissions.sort()).toEqual(['branches.view', 'users.view']);
    expect((await request(app).get('/api/users').set(bearer(desk))).status).toBe(200);
    expect((await request(app).post('/api/roles').set(bearer(desk)).send({ name: 'Y', permissions: [] })).status).toBe(403);
  });

  it('system roles cannot be edited by institutes', async () => {
    const app = await getApp();
    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const teacherRole = roles.body.find((r: { slug: string }) => r.slug === 'teacher');
    const res = await request(app).put(`/api/roles/${teacherRole.id}`).set(bearer(admin)).send({ name: 'Teacher Plus', permissions: [] });
    expect(res.status).toBe(404);
  });

  it('super admin routes are closed to institute users', async () => {
    expect((await request(await getApp()).get('/api/admin/institutes').set(bearer(admin))).status).toBe(403);
  });
});
