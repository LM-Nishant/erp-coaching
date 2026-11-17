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

  it('shows institute-wide files to branch-restricted users but keeps other branches hidden', async () => {
    const app = await getApp();
    const teacher = (await login(USERS.apexTeacher)).accessToken; // restricted to Apex branch 1
    const branchAdmin = (await login(USERS.apexBranchAdmin)).accessToken; // restricted, has files.delete
    const branches = (await request(app).get('/api/branches').set(bearer(apex))).body as { id: number }[];
    const [own, other] = branches.map((b) => b.id).sort((a, b) => a - b);
    const upload = (token: string, name: string, branchId?: number) => {
      const req = request(app).post('/api/files').set(bearer(token)).field('module', 'wide-test');
      if (branchId) req.field('branchId', String(branchId));
      return req.attach('file', Buffer.from(name), { filename: `${name}.txt`, contentType: 'text/plain' });
    };

    const wide = await upload(apex, 'institute-wide');
    const otherBranch = await upload(apex, 'other-branch', other);
    expect(wide.body.branchId).toBeNull();

    const list = await request(app).get('/api/files?module=wide-test').set(bearer(teacher));
    const ids = list.body.items.map((f: { id: number }) => f.id);
    expect(ids).toContain(wide.body.id);
    expect(ids).not.toContain(otherBranch.body.id);
    expect((await request(app).get(`/api/files/${wide.body.id}/url`).set(bearer(teacher))).status).toBe(200);
    expect(
      (await request(app).get(`/api/files/${otherBranch.body.id}/url`).set(bearer(teacher))).status,
    ).toBe(404);

    // Branch-restricted users can read but not delete institute-wide files...
    expect((await request(app).delete(`/api/files/${wide.body.id}`).set(bearer(branchAdmin))).status).toBe(
      403,
    );
    // ...and their own uploads default to their branch instead of becoming institute-wide.
    const mine = await upload(teacher, 'teacher-upload');
    expect(mine.status).toBe(201);
    expect(mine.body.branchId).toBe(own);
  });

  it('signs module-owned files (LMS, exams…) only for their uploader', async () => {
    const app = await getApp();
    const teacher = (await login(USERS.apexTeacher)).accessToken;
    const upload = (module: string) =>
      request(app)
        .post('/api/files')
        .set(bearer(apex))
        .field('module', module)
        .attach('file', Buffer.from(module), { filename: `${module}.txt`, contentType: 'text/plain' });
    const owned = await upload('lms');
    const generic = await upload('academics');
    expect((await request(app).get(`/api/files/${owned.body.id}/url`).set(bearer(teacher))).status).toBe(404);
    expect((await request(app).get(`/api/files/${owned.body.id}/url`).set(bearer(apex))).status).toBe(200);
    expect((await request(app).get(`/api/files/${generic.body.id}/url`).set(bearer(teacher))).status).toBe(
      200,
    );
  });

  it('rejects requests without a file', async () => {
    const res = await request(await getApp())
      .post('/api/files')
      .set(bearer(apex))
      .field('module', 'general');
    expect(res.status).toBe(400);
  });
});
