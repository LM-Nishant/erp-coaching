import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Branch } from '../src/modules/branches/branch.model';
import { runWithContext } from '../src/shared/context';
import { TenantRepository } from '../src/shared/tenancy/tenant-repository';
import { USERS, bearer, getApp, login } from './helpers';

describe('multi-tenant isolation', () => {
  let apex: string;
  let zenith: string;
  let zenithBranchId: number;
  let apexBranchIds: number[];

  beforeAll(async () => {
    await getApp();
    apex = (await login(USERS.apexAdmin)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    const zb = await Branch.findOne({ where: { instituteId: 2 } });
    zenithBranchId = zb!.id;
    apexBranchIds = (await Branch.findAll({ where: { instituteId: 1 } })).map((b) => b.id);
  });

  it('lists only own branches', async () => {
    const res = await request(await getApp())
      .get('/api/branches')
      .set(bearer(apex));
    expect(res.status).toBe(200);
    expect(res.body.map((b: { id: number }) => b.id).sort()).toEqual([...apexBranchIds].sort());
    expect(res.body.every((b: { instituteId: number }) => b.instituteId === 1)).toBe(true);
  });

  it("blocks reading, updating and deleting another institute's branch", async () => {
    const app = await getApp();
    expect((await request(app).get(`/api/branches/${zenithBranchId}`).set(bearer(apex))).status).toBe(404);
    expect(
      (await request(app).patch(`/api/branches/${zenithBranchId}`).set(bearer(apex)).send({ name: 'Hacked' }))
        .status,
    ).toBe(404);
    expect((await request(app).delete(`/api/branches/${zenithBranchId}`).set(bearer(apex))).status).toBe(404);
    const still = await Branch.findOne({ where: { instituteId: 2, id: zenithBranchId } });
    expect(still!.name).not.toBe('Hacked');
  });

  it('ignores client-supplied institute ids', async () => {
    const app = await getApp();
    const res = await request(app)
      .post('/api/branches')
      .set(bearer(apex))
      .send({ name: 'Sneaky', code: 'SNEAKY', instituteId: 2 });
    expect(res.status).toBe(201);
    expect(res.body.instituteId).toBe(1);
  });

  it('enforces plan limits (Zenith Starter plan allows 2 branches)', async () => {
    const res = await request(await getApp())
      .post('/api/branches')
      .set(bearer(zenith))
      .send({ name: 'Third', code: 'B3' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('rejects an X-Branch-Id from another institute', async () => {
    const res = await request(await getApp())
      .get('/api/branches')
      .set(bearer(apex))
      .set('X-Branch-Id', String(zenithBranchId));
    expect(res.status).toBe(403);
  });

  it('refuses to switch into an institute the user is not a member of', async () => {
    const res = await request(await getApp())
      .post('/api/auth/select-institute')
      .set(bearer(apex))
      .send({ instituteId: 2 });
    expect(res.status).toBe(403);
  });

  it('tenant guard rejects unscoped queries on tenant models', async () => {
    await expect(Branch.findAll()).rejects.toThrow(/Tenant guard/);
    await expect(Branch.count()).rejects.toThrow(/Tenant guard/);
  });

  it('TenantRepository always scopes to the context institute', async () => {
    const repo = new TenantRepository(Branch);
    const rows = await runWithContext({ userId: 1, instituteId: 1, allowedBranchIds: null }, () =>
      repo.findAll({ where: { instituteId: 2 } }),
    );
    expect(rows.every((b) => b.instituteId === 1)).toBe(true);
  });
});
