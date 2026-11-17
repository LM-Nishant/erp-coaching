import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { USERS, bearer, getApp, login } from './helpers';

describe('file storage', () => {
  let apex: string;
  let zenith: string;

  beforeAll(async () => {
    await getApp();
    apex = (await login(USERS.apexAdmin)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
  });

  it('uploads to local disk and serves via short-lived signed URL with Range support', async () => {
    const app = await getApp();
    const content = Buffer.from('hello coaching erp — signed url test');
    const up = await request(app)
      .post('/api/files')
      .set(bearer(apex))
      .field('module', 'general')
      .attach('file', content, { filename: 'note.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);
    expect(up.body.url).toContain('/api/files/signed/');

    const path = new URL(up.body.url).pathname;
    const dl = await request(app).get(path);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe(content.toString());

    const partial = await request(app).get(path).set('Range', 'bytes=0-4');
    expect(partial.status).toBe(206);
    expect(partial.text).toBe('hello');

    const tampered = path.slice(0, -2) + (path.endsWith('aa') ? 'bb' : 'aa');
    expect((await request(app).get(tampered)).status).toBe(404);

    // Another tenant cannot mint URLs for this file.
    expect((await request(app).get(`/api/files/${up.body.id}/url`).set(bearer(zenith))).status).toBe(404);
  });

  it('rejects requests without a file', async () => {
    const res = await request(await getApp())
      .post('/api/files')
      .set(bearer(apex))
      .field('module', 'general');
    expect(res.status).toBe(400);
  });
});
