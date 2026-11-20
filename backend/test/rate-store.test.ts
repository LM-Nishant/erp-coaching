import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createClient } from 'redis';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import type { RedisClient } from '../src/infrastructure/redis';
import { SharedStore } from '../src/infrastructure/rate-store';

/** Rate-limit counters: shared through Redis when it's reachable, per process otherwise. */

const WINDOW = { windowMs: 60_000 } as Parameters<SharedStore['init']>[0];

describe('rate-limit store without a reachable Redis', () => {
  it('counts in memory when the client is not connected', async () => {
    const client: RedisClient = createClient({ url: 'redis://127.0.0.1:1', disableOfflineQueue: true });
    const store = new SharedStore(client, 'offline');
    store.init(WINDOW);
    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    expect((await store.get('k'))?.totalHits).toBe(2);
    await store.resetKey('k');
    expect(await store.get('k')).toBeUndefined();
  });

  it('counts in memory when Redis commands fail', async () => {
    const failing = {
      isReady: true,
      sendCommand: () => Promise.reject(new Error('connection lost')),
    } as unknown as RedisClient;
    const store = new SharedStore(failing, 'failing');
    store.init(WINDOW);
    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
  });
});

describe.skipIf(!process.env.TEST_REDIS_URL)('rate-limit store with Redis', () => {
  const name = `test-${crypto.randomBytes(4).toString('hex')}`;
  const clients: RedisClient[] = [];

  async function instance() {
    const client: RedisClient = createClient({ url: process.env.TEST_REDIS_URL });
    await client.connect();
    clients.push(client);
    const app = express();
    app.get(
      '/',
      rateLimit({ windowMs: 60_000, limit: 2, store: new SharedStore(client, name) }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    return app;
  }

  afterAll(async () => {
    const [client] = clients;
    if (client) {
      const keys = await client.keys(`rl:${name}:*`);
      if (keys.length) await client.del(keys);
    }
    await Promise.all(clients.map((c) => c.close()));
  });

  it('shares one limit across API instances', async () => {
    const [a, b] = [await instance(), await instance()];
    expect((await request(a).get('/')).status).toBe(200);
    expect((await request(b).get('/')).status).toBe(200);
    const limited = await request(a).get('/');
    expect(limited.status).toBe(429);
    expect((await request(b).get('/')).status).toBe(429);
  });
});
