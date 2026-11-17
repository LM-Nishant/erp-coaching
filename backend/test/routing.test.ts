import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { discoverModules } from '../src/infrastructure/module-loader';
import { authenticate } from '../src/shared/middleware/authenticate';
import { defineModule } from '../src/shared/module';
import { getApp } from './helpers';

/** Registered after every real module, so any root-level auth middleware would block it. */
const zzPublic = defineModule({
  name: 'zz-public',
  routes: (api) => {
    const r = Router();
    r.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    api.use('/zz-public', r);
  },
});

describe('module routing isolation', () => {
  it('keeps public routes of later modules reachable without a token', async () => {
    await getApp();
    const app = createApp([...(await discoverModules()), zzPublic]);
    const res = await request(app).get('/api/zz-public/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Protected routes still require auth.
    expect((await request(app).get('/api/roles')).status).toBe(401);
    expect((await request(app).get('/api/permissions')).status).toBe(401);
  });

  it('refuses to boot when a module mounts middleware at the API root', async () => {
    const leaky = defineModule({
      name: 'leaky',
      routes: (api) => {
        const r = Router();
        r.use(authenticate);
        api.use('/', r);
      },
    });
    expect(() => createApp([leaky])).toThrow(/leaky.*API root/);
  });
});
