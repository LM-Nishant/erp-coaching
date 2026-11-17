import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AiSetting } from '../src/modules/ai/models';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { USERS, bearer, getApp, login } from './helpers';

describe('super admin platform', () => {
  let sa: string;

  beforeAll(async () => {
    await getApp();
    sa = (await login(USERS.superAdmin)).accessToken;
  });

  it('creates an institute with main branch, subscription and admin', async () => {
    const app = await getApp();
    const plans = await request(app).get('/api/admin/plans').set(bearer(sa));
    const res = await request(app)
      .post('/api/admin/institutes')
      .set(bearer(sa))
      .send({
        name: 'Nova Tutorials',
        slug: 'nova',
        planId: plans.body[0].id,
        admin: { name: 'Nova Admin', mobile: '9300000001', password: 'Password@123' },
      });
    expect(res.status).toBe(201);
    const novaAdmin = (await login({ mobile: '9300000001', password: 'Password@123' })).accessToken;
    const me = await request(app).get('/api/auth/me').set(bearer(novaAdmin));
    expect(me.body.institute.slug).toBe('nova');
    expect(me.body.branches).toHaveLength(1);
  });

  it('suspending an institute blocks its users', async () => {
    const app = await getApp();
    const list = await request(app).get('/api/admin/institutes').set(bearer(sa));
    const nova = list.body.items.find((i: { slug: string }) => i.slug === 'nova');
    const novaAdmin = (await login({ mobile: '9300000001', password: 'Password@123' })).accessToken;
    await request(app).post(`/api/admin/institutes/${nova.id}/status`).set(bearer(sa)).send({ status: 'suspended' }).expect(200);
    const res = await request(app).get('/api/branches').set(bearer(novaAdmin));
    expect(res.status).toBe(403);
    await request(app).post(`/api/admin/institutes/${nova.id}/status`).set(bearer(sa)).send({ status: 'active' }).expect(200);
  });

  it('impersonation is scoped, audited and cannot reach admin routes', async () => {
    const app = await getApp();
    const imp = await request(app).post('/api/auth/impersonate').set(bearer(sa)).send({ instituteId: 1, reason: 'support ticket #1' });
    expect(imp.status).toBe(200);
    const me = await request(app).get('/api/auth/me').set(bearer(imp.body.accessToken));
    expect(me.body.institute.slug).toBe('apex');
    expect(me.body.impersonatedBy).toBeTruthy();
    expect((await request(app).get('/api/admin/institutes').set(bearer(imp.body.accessToken))).status).toBe(403);

    await request(app).post('/api/branches').set(bearer(imp.body.accessToken)).send({ name: 'Imp Branch', code: 'IMP' }).expect(201);
    const ev = await AuditEvent.findOne({ where: { action: 'branch.created', instituteId: 1 }, order: [['id', 'DESC']] });
    expect(ev!.impersonatorUserId).toBeTruthy();
    expect(await AuditEvent.count({ where: { action: 'impersonation.started' } })).toBeGreaterThan(0);

    await request(app).post('/api/auth/impersonation/stop').set(bearer(imp.body.accessToken)).expect(204);
    expect((await request(app).get('/api/auth/me').set(bearer(imp.body.accessToken))).status).toBe(401);
  });

  it('AI settings: key encrypted at rest and never returned', async () => {
    const app = await getApp();
    const key = 'sk-test-AQ1234567890abcdefghijSf9Q';
    const put = await request(app)
      .put('/api/admin/ai/settings')
      .set(bearer(sa))
      .send({ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', jsonMode: true, apiKey: key });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain(key);
    expect(put.body).toMatchObject({ hasKey: true, keySource: 'database', provider: 'groq' });
    expect(put.body.keyHint).toMatch(/^sk….Sf9Q$/);

    const row = await AiSetting.findOne({ where: { scope: 'global' } });
    expect(row!.apiKeyEncrypted).not.toContain(key);

    // Empty key keeps the stored key.
    const keep = await request(app)
      .put('/api/admin/ai/settings')
      .set(bearer(sa))
      .send({ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', jsonMode: false, apiKey: '' });
    expect(keep.body).toMatchObject({ hasKey: true, model: 'llama-3.1-8b-instant', jsonMode: false });

    const removed = await request(app).delete('/api/admin/ai/settings/key').set(bearer(sa));
    expect(removed.body.hasKey).toBe(false);

    const admin = (await login(USERS.apexAdmin)).accessToken;
    expect((await request(app).get('/api/admin/ai/settings').set(bearer(admin))).status).toBe(403);
  });

  it('AI test connection reports provider failures without throwing', async () => {
    const res = await request(await getApp())
      .post('/api/admin/ai/settings/test')
      .set(bearer(sa))
      .send({ provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'x', jsonMode: false, apiKey: 'k' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });
});
