import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getGuardianUserIds,
  getLinkedStudents,
  getStudentUserId,
} from '../src/modules/guardians/guardian-access';
import { USERS, bearer, getApp, lastOtpFor, login, newDevice } from './helpers';

let seq = 0;
const mobile = () => `932${String(seq++).padStart(7, '0')}`;

async function otpLogin(m: string) {
  const app = await getApp();
  const device = newDevice();
  const ch = await request(app).post('/api/auth/otp/request').send({ mobile: m, device });
  expect(ch.body.challengeId).toBeTruthy();
  const res = await request(app)
    .post('/api/auth/otp/verify')
    .send({ challengeId: ch.body.challengeId, code: lastOtpFor(m), device });
  expect(res.body.status).toBe('authenticated');
  return res.body.accessToken as string;
}

describe('guardians', () => {
  let apex: string;
  let zenith: string;
  const student = async (token: string, name: string) => {
    const r = await request(await getApp())
      .post('/api/students')
      .set(bearer(token))
      .send({ name, mobile: mobile() });
    expect(r.status).toBe(201);
    return r.body as { id: number; userId: number | null };
  };

  beforeAll(async () => {
    await getApp();
    apex = (await login(USERS.apexAdmin)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
  });

  it('links one guardian to several children and the parent sees only them', async () => {
    const app = await getApp();
    const a = await student(apex, 'Child Alpha');
    const b = await student(apex, 'Child Beta');
    const other = await student(apex, 'Other Child');
    const pm = mobile();
    const l1 = await request(app)
      .post(`/api/students/${a.id}/guardians`)
      .set(bearer(apex))
      .send({ name: 'Parent Prime', mobile: pm, relation: 'father' });
    expect(l1.status).toBe(201);
    expect(l1.body).toMatchObject({ relation: 'father', status: 'active', isPrimary: true });
    const l2 = await request(app)
      .post(`/api/students/${b.id}/guardians`)
      .set(bearer(apex))
      .send({ name: 'Parent Prime', mobile: pm, relation: 'father' });
    expect(l2.status).toBe(201);
    expect(l2.body.guardianId).toBe(l1.body.guardianId);
    expect(
      (
        await request(app)
          .post(`/api/students/${a.id}/guardians`)
          .set(bearer(apex))
          .send({ name: 'Parent Prime', mobile: pm })
      ).body.error.code,
    ).toBe('ALREADY_LINKED');

    const parent = await otpLogin(pm);
    const kids = await request(app).get('/api/guardian-portal/children').set(bearer(parent));
    expect(kids.status).toBe(200);
    expect(kids.body.map((k: { studentId: number }) => k.studentId).sort()).toEqual([a.id, b.id].sort());
    expect((await request(app).get(`/api/guardian-portal/children/${a.id}`).set(bearer(parent))).status).toBe(
      200,
    );
    expect(
      (await request(app).get(`/api/guardian-portal/children/${other.id}`).set(bearer(parent))).status,
    ).toBe(404);
    // Parents have no staff access to the student registry.
    expect((await request(app).get(`/api/students/${other.id}`).set(bearer(parent))).status).toBe(403);

    // Revoking a link removes access immediately.
    const rev = await request(app)
      .patch(`/api/students/${b.id}/guardians/${l2.body.linkId}`)
      .set(bearer(apex))
      .send({ status: 'revoked' });
    expect(rev.status).toBe(200);
    expect((await request(app).get(`/api/guardian-portal/children/${b.id}`).set(bearer(parent))).status).toBe(
      404,
    );

    // Integration helpers for other modules.
    const ids = await getGuardianUserIds(a.id, 1);
    expect(ids).toEqual([l1.body.userId]);
    expect(await getGuardianUserIds(a.id, 2)).toEqual([]);
    expect(await getStudentUserId(a.id, 1)).toBe(a.userId);
    expect((await getLinkedStudents(l1.body.userId, 1)).map((s) => s.id)).toEqual([a.id]);
  });

  it('enforces the configurable max guardians per student', async () => {
    const app = await getApp();
    const s = await student(zenith, 'Max Kid');
    await request(app).put('/api/students/settings').set(bearer(zenith)).send({ maxGuardiansPerStudent: 1 });
    expect(
      (
        await request(app)
          .post(`/api/students/${s.id}/guardians`)
          .set(bearer(zenith))
          .send({ name: 'Mom One', mobile: mobile(), relation: 'mother' })
      ).status,
    ).toBe(201);
    const over = await request(app)
      .post(`/api/students/${s.id}/guardians`)
      .set(bearer(zenith))
      .send({ name: 'Dad Two', mobile: mobile(), relation: 'father' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('GUARDIAN_LIMIT_REACHED');
    await request(app).put('/api/students/settings').set(bearer(zenith)).send({ maxGuardiansPerStudent: 2 });
  });

  it('pending links grant nothing until approved', async () => {
    const app = await getApp();
    const s = await student(apex, 'Pending Kid');
    const pm = mobile();
    const link = await request(app)
      .post(`/api/students/${s.id}/guardians`)
      .set(bearer(apex))
      .send({ name: 'Pending Parent', mobile: pm });
    await request(app)
      .patch(`/api/students/${s.id}/guardians/${link.body.linkId}`)
      .set(bearer(apex))
      .send({ status: 'pending' });
    const parent = await otpLogin(pm);
    expect(
      (await request(app).get(`/api/guardian-portal/children/${s.id}`).set(bearer(parent))).status,
    ).not.toBe(200);
    await request(app)
      .patch(`/api/students/${s.id}/guardians/${link.body.linkId}`)
      .set(bearer(apex))
      .send({ status: 'active' });
    const again = await otpLogin(pm);
    expect((await request(app).get(`/api/guardian-portal/children/${s.id}`).set(bearer(again))).status).toBe(
      200,
    );
  });

  it('isolates guardians across institutes', async () => {
    const app = await getApp();
    const z = await student(zenith, 'Zenith Kid');
    expect(
      (
        await request(app)
          .post(`/api/students/${z.id}/guardians`)
          .set(bearer(apex))
          .send({ name: 'Intruder', mobile: mobile() })
      ).status,
    ).toBe(404);
    expect((await request(app).get(`/api/students/${z.id}/guardians`).set(bearer(apex))).status).toBe(404);
    const list = await request(app).get('/api/guardians').set(bearer(zenith));
    expect(list.status).toBe(200);
    const apexList = await request(app).get('/api/guardians').set(bearer(apex));
    const zIds = new Set(list.body.items.map((g: { id: number }) => g.id));
    expect(apexList.body.items.some((g: { id: number }) => zIds.has(g.id))).toBe(false);
  });

  it('forbids the teacher from linking guardians', async () => {
    const app = await getApp();
    const teacher = (await login(USERS.apexTeacher)).accessToken;
    const s = await student(apex, 'Teacher Kid');
    expect(
      (
        await request(app)
          .post(`/api/students/${s.id}/guardians`)
          .set(bearer(teacher))
          .send({ name: 'Nope', mobile: mobile() })
      ).status,
    ).toBe(403);
  });
});
