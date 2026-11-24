import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { User } from '../src/modules/users/user.model';
import { USERS, bearer, getApp, login } from './helpers';

describe('hr module', () => {
  let admin: string;
  let teacher: string;
  let zenith: string;
  let teacherUserId: number;
  let teacherEmpId: number;
  let staffId: number;
  const api = async () => request(await getApp());

  beforeAll(async () => {
    await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    teacherUserId = (await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } }))!.id;
  });

  it('creates an employee linked to a user (teacher) and lists it', async () => {
    const cands = await (await api()).get('/api/hr/employees/candidates').set(bearer(admin));
    expect(cands.status).toBe(200);
    expect(cands.body.some((c: { id: number }) => c.id === teacherUserId)).toBe(true);

    const res = await (await api()).post('/api/hr/employees').set(bearer(admin)).send({
      userId: teacherUserId,
      dateOfJoining: '2024-06-01',
      designation: 'Physics faculty',
      biometricEnrolmentId: 'BIO-1',
    });
    expect(res.status).toBe(201);
    expect(res.body.isTeacher).toBe(true);
    expect(res.body.instituteId).toBe(1);
    expect(res.body.employeeCode).toMatch(/^EMP\d{4}$/);
    expect(res.body.name).toBeTruthy();
    teacherEmpId = res.body.id;

    const dup = await (
      await api()
    )
      .post('/api/hr/employees')
      .set(bearer(admin))
      .send({ userId: teacherUserId, dateOfJoining: '2024-06-01' });
    expect(dup.status).toBe(409);

    const list = await (await api()).get('/api/hr/employees?isTeacher=true').set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.items.map((e: { id: number }) => e.id)).toContain(teacherEmpId);
  });

  it('tells /auth/me which users have a staff profile, so only they see HR self-service', async () => {
    const features = async (token: string) =>
      (await (await api()).get('/api/auth/me').set(bearer(token))).body.features;
    expect(await features(teacher)).toEqual(['staff-profile']);
    expect(await features(admin)).toEqual([]);
  });

  it('supports CRUD on staff and their qualifications', async () => {
    const create = await (
      await api()
    )
      .post('/api/hr/employees')
      .set(bearer(admin))
      .send({ name: 'Ravi Office', dateOfJoining: '2024-01-01', department: 'Admin', instituteId: 2 });
    expect(create.status).toBe(201);
    expect(create.body.instituteId).toBe(1);
    staffId = create.body.id;

    const patch = await (
      await api()
    )
      .patch(`/api/hr/employees/${staffId}`)
      .set(bearer(admin))
      .send({ designation: 'Clerk' });
    expect(patch.body.designation).toBe('Clerk');

    const q = await (
      await api()
    )
      .post(`/api/hr/employees/${staffId}/qualifications`)
      .set(bearer(admin))
      .send({ degree: 'B.Com', institution: 'DU', yearOfPassing: 2015 });
    expect(q.status).toBe(201);
    const ql = await (await api()).get(`/api/hr/employees/${staffId}/qualifications`).set(bearer(admin));
    expect(ql.body).toHaveLength(1);
    expect(
      (
        await (
          await api()
        )
          .delete(`/api/hr/employees/${staffId}/qualifications/${q.body.id}`)
          .set(bearer(admin))
      ).status,
    ).toBe(204);

    const tmp = await (
      await api()
    )
      .post('/api/hr/employees')
      .set(bearer(admin))
      .send({ name: 'Temp Person', dateOfJoining: '2024-01-01' });
    expect((await (await api()).delete(`/api/hr/employees/${tmp.body.id}`).set(bearer(admin))).status).toBe(
      204,
    );
    expect((await (await api()).get(`/api/hr/employees/${tmp.body.id}`).set(bearer(admin))).status).toBe(404);
  });

  it('uploads and lists employee documents with signed URLs', async () => {
    const up = await (
      await api()
    )
      .post(`/api/hr/employees/${staffId}/documents`)
      .set(bearer(admin))
      .field('title', 'Offer letter')
      .attach('file', Buffer.from('%PDF-1.4 test'), {
        filename: 'offer.pdf',
        contentType: 'application/pdf',
      });
    expect(up.status).toBe(201);
    const docs = await (await api()).get(`/api/hr/employees/${staffId}/documents`).set(bearer(admin));
    expect(docs.body[0].file.url).toContain('/api/files/signed/');
  });

  it('forbids staff without hr permissions from admin routes', async () => {
    expect((await (await api()).get('/api/hr/employees').set(bearer(teacher))).status).toBe(403);
    expect((await (await api()).post('/api/hr/shifts').set(bearer(teacher)).send({})).status).toBe(403);
  });

  it("isolates another institute's employees", async () => {
    const app = await api();
    expect((await app.get(`/api/hr/employees/${teacherEmpId}`).set(bearer(zenith))).status).toBe(404);
    expect(
      (
        await (
          await api()
        )
          .patch(`/api/hr/employees/${teacherEmpId}`)
          .set(bearer(zenith))
          .send({ name: 'Hacked' })
      ).status,
    ).toBe(404);
    expect(
      (await (await api()).get(`/api/hr/employees/${teacherEmpId}/documents`).set(bearer(zenith))).status,
    ).toBe(404);
    const list = await (await api()).get('/api/hr/employees').set(bearer(zenith));
    expect(list.body.items.every((e: { instituteId: number }) => e.instituteId === 2)).toBe(true);
    const leaves = await (await api()).get('/api/hr/leaves').set(bearer(zenith));
    expect(leaves.body.items).toHaveLength(0);
  });

  it('lets an employee apply for leave and approval marks attendance', async () => {
    const types = await (await api()).get('/api/hr/me/leave-types').set(bearer(teacher));
    const cl = types.body.find((t: { code: string }) => t.code === 'CL');
    expect(cl).toBeTruthy();

    const apply = await (
      await api()
    )
      .post('/api/hr/me/leaves')
      .set(bearer(teacher))
      .send({ leaveTypeId: cl.id, fromDate: '2025-01-06', toDate: '2025-01-07', reason: 'Family function' });
    expect(apply.status).toBe(201);
    expect(apply.body.days).toBe(2);

    const overlap = await (
      await api()
    )
      .post('/api/hr/me/leaves')
      .set(bearer(teacher))
      .send({ leaveTypeId: cl.id, fromDate: '2025-01-07', toDate: '2025-01-08' });
    expect(overlap.status).toBe(409);

    // employees cannot approve their own leave
    expect(
      (
        await (
          await api()
        )
          .post(`/api/hr/leaves/${apply.body.id}/decision`)
          .set(bearer(teacher))
          .send({ approve: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await (
          await api()
        )
          .post(`/api/hr/leaves/${apply.body.id}/decision`)
          .set(bearer(zenith))
          .send({ approve: true })
      ).status,
    ).toBe(404);

    const ok = await (
      await api()
    )
      .post(`/api/hr/leaves/${apply.body.id}/decision`)
      .set(bearer(admin))
      .send({ approve: true });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');

    const att = await (await api()).get('/api/hr/me/attendance?year=2025&month=1').set(bearer(teacher));
    expect(att.body.map((a: { date: string; status: string }) => [a.date, a.status])).toEqual([
      ['2025-01-06', 'leave'],
      ['2025-01-07', 'leave'],
    ]);
    const bal = await (await api()).get('/api/hr/me/leave-balances?year=2025').set(bearer(teacher));
    expect(bal.body.find((b: { code: string }) => b.code === 'CL').used).toBe(2);
  });

  it('records manual and biometric attendance and summarises loss-of-pay days', async () => {
    const shift = await (
      await api()
    )
      .post('/api/hr/shifts')
      .set(bearer(admin))
      .send({ name: 'Morning', startTime: '09:00', endTime: '17:00', graceMinutes: 10 });
    expect(shift.status).toBe(201);
    await (
      await api()
    )
      .patch(`/api/hr/employees/${teacherEmpId}`)
      .set(bearer(admin))
      .send({ shiftId: shift.body.id });

    const manual = await (
      await api()
    )
      .put('/api/hr/attendance')
      .set(bearer(admin))
      .send({
        entries: [
          { employeeId: teacherEmpId, date: '2025-01-10', status: 'absent' },
          { employeeId: teacherEmpId, date: '2025-01-13', status: 'half_day' },
        ],
      });
    expect(manual.status).toBe(200);

    const bio = await (
      await api()
    )
      .post('/api/hr/attendance/biometric')
      .set(bearer(admin))
      .send({
        punches: [
          { deviceSerial: 'DEV1', enrolmentId: 'BIO-1', punchedAt: '2025-01-14T09:25:00' },
          { deviceSerial: 'DEV1', enrolmentId: 'BIO-1', punchedAt: '2025-01-14T17:05:00' },
          { deviceSerial: 'DEV1', enrolmentId: 'BIO-1', punchedAt: '2025-01-06T09:00:00' },
          { deviceSerial: 'DEV1', enrolmentId: 'UNKNOWN', punchedAt: '2025-01-14T09:00:00' },
        ],
      });
    expect(bio.body).toMatchObject({ updated: 1, skipped: 1, unmatched: ['UNKNOWN'] });

    const sum = await (await api()).get('/api/hr/attendance/summary?year=2025&month=1').set(bearer(admin));
    const row = sum.body.find((r: { employee: { id: number } }) => r.employee.id === teacherEmpId);
    expect(row).toMatchObject({ leave: 2, absent: 1, half_day: 1, late: 1, lopDays: 1.5 });

    expect(
      (
        await (
          await api()
        )
          .put('/api/hr/attendance')
          .set(bearer(zenith))
          .send({ entries: [{ employeeId: teacherEmpId, date: '2025-01-15', status: 'present' }] })
      ).status,
    ).toBe(404);
  });

  it('handles assets and the resignation / notice-period lifecycle', async () => {
    const asset = await (await api()).post('/api/hr/assets').set(bearer(admin)).send({
      employeeId: staffId,
      name: 'Laptop',
      assetTag: 'LT-01',
      issuedOn: '2024-01-02',
      valuePaise: 4000000,
    });
    expect(asset.status).toBe(201);
    const ret = await (
      await api()
    )
      .patch(`/api/hr/assets/${asset.body.id}`)
      .set(bearer(admin))
      .send({ status: 'returned' });
    expect(ret.body.returnedOn).toBeTruthy();

    const sep = await (
      await api()
    )
      .post('/api/hr/separations')
      .set(bearer(admin))
      .send({ employeeId: staffId, submittedOn: '2025-02-01', noticePeriodDays: 30, reason: 'Relocating' });
    expect(sep.status).toBe(201);
    expect(sep.body.lastWorkingDay).toBe('2025-03-03');
    expect(
      (
        await (
          await api()
        )
          .post('/api/hr/separations')
          .set(bearer(admin))
          .send({ employeeId: staffId, submittedOn: '2025-02-02' })
      ).status,
    ).toBe(409);

    await (await api()).post(`/api/hr/separations/${sep.body.id}/accept`).set(bearer(admin)).send({});
    expect((await (await api()).get(`/api/hr/employees/${staffId}`).set(bearer(admin))).body.status).toBe(
      'on_notice',
    );
    expect(
      (await (await api()).post(`/api/hr/separations/${sep.body.id}/accept`).set(bearer(admin)).send({}))
        .status,
    ).toBe(409);
    await (await api()).post(`/api/hr/separations/${sep.body.id}/complete`).set(bearer(admin)).send({});
    const emp = await (await api()).get(`/api/hr/employees/${staffId}`).set(bearer(admin));
    expect(emp.body).toMatchObject({ status: 'exited', dateOfExit: '2025-03-03' });
  });
});
