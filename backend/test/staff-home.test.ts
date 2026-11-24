import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { beforeAll, describe, expect, it } from 'vitest';
import { SETUP_STEPS } from '@erp/shared';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { runWithContext } from '../src/shared/context';
import { registerRecipientResolver, resolveAudience } from '../src/modules/notifications/recipients';
import { User } from '../src/modules/users/user.model';
import { USERS, bearer, getApp, login } from './helpers';

const asApex = <T>(fn: () => Promise<T>) =>
  runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, fn);

describe('staff home support', () => {
  let admin: string;
  let teacher: string;

  beforeAll(async () => {
    await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
  });

  it('reports the setup checklist from what the institute already has', async () => {
    const app = await getApp();
    const res = await request(app).get('/api/institute/setup-status').set(bearer(admin));
    expect(res.status).toBe(200);
    const keys = res.body.steps.map((s: { key: string }) => s.key);
    // Order is the checklist order; plan-disabled modules drop out.
    expect(keys).toEqual(SETUP_STEPS.filter((k) => keys.includes(k)));
    expect(keys).toEqual(expect.arrayContaining(['profile', 'teacher']));

    const [{ batches }] = await getSequelize().query<{ batches: number }>(
      'SELECT COUNT(*) AS batches FROM batches WHERE institute_id = 1',
      { type: QueryTypes.SELECT },
    );
    const batch = res.body.steps.find((s: { key: string }) => s.key === 'batch');
    if (batch) expect(batch).toEqual({ key: 'batch', count: Number(batches), done: Number(batches) > 0 });
    const done = res.body.steps.filter((s: { done: boolean }) => s.done).length;
    expect(res.body).toMatchObject({ done, total: keys.length, complete: done === keys.length });
  });

  it('keeps the checklist to staff who configure the institute', async () => {
    const app = await getApp();
    const res = await request(app).get('/api/institute/setup-status').set(bearer(teacher));
    expect(res.status).toBe(403);
  });

  it('sends a batch notice to the chosen students, parents or teachers', async () => {
    // Stand-ins for the academics and guardians resolvers (this file's module registry only).
    const ids = Object.fromEntries(
      await Promise.all(
        Object.entries({
          student: '9100000005',
          parent: '9100000006',
          teacher: USERS.apexTeacher.mobile,
        }).map(async ([k, mobile]) => [k, (await User.findOne({ where: { mobile } }))!.id] as const),
      ),
    );
    registerRecipientResolver('batchMembers', async (args) => {
      const { students, teachers } = args as { students?: boolean; teachers?: boolean };
      return [...(students ? [ids.student] : []), ...(teachers ? [ids.teacher] : [])];
    });
    registerRecipientResolver('guardiansOfStudentUsers', async (userIds) =>
      (userIds as number[]).includes(ids.student) ? [ids.parent] : [],
    );
    const resolve = (batchRecipients?: ('students' | 'parents' | 'teachers')[]) =>
      asApex(async () => Object.fromEntries(await resolveAudience({ batchIds: [7], batchRecipients })));

    expect(await resolve(['parents'])).toEqual({ [ids.parent]: 'guardian' });
    expect(await resolve(['teachers'])).toEqual({ [ids.teacher]: 'staff' });
    expect(await resolve(['students', 'parents'])).toEqual({
      [ids.student]: 'student',
      [ids.parent]: 'guardian',
    });
    // No choice keeps the earlier meaning: the batch's students and teachers.
    expect(await resolve()).toEqual({ [ids.student]: 'student', [ids.teacher]: 'staff' });
  });

  it('validates the batch recipient choice on campaigns', async () => {
    const app = await getApp();
    const res = await request(app)
      .post('/api/notifications/campaigns')
      .set(bearer(admin))
      .send({
        title: 'Bad audience',
        channels: ['in_app'],
        body: 'x',
        audience: { batchIds: [1], batchRecipients: ['everyone'] },
      });
    expect(res.status).toBe(422);
  });

  it('previews how many people a notice reaches before sending', async () => {
    const app = await getApp();
    const preview = (token: string, audience: unknown) =>
      request(app).post('/api/notifications/campaigns/preview').set(bearer(token)).send({ audience });

    const teachers = (await asApex(() => resolveAudience({ roles: ['teacher'] }))).size;
    expect(teachers).toBeGreaterThan(0);
    const res = await preview(admin, { roles: ['teacher'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recipients: teachers });

    expect((await preview(admin, {})).status).toBe(422);
    expect((await preview(teacher, { roles: ['teacher'] })).status).toBe(403);
  });
});
