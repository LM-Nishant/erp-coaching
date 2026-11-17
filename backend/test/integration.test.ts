import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Branch } from '../src/modules/branches/branch.model';
import { BatchStudent } from '../src/modules/academics/models';
import { NotificationMessage } from '../src/modules/notifications/models';
import { WorkUnit } from '../src/modules/payroll/models';
import { Subscription } from '../src/modules/subscriptions/models';
import { Employee } from '../src/modules/hr/models';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { USERS, bearer, getApp, lastOtpFor, login, newDevice } from './helpers';

/** Cross-module wiring (see CONTRIBUTING "Cross-module wiring"). */
let seq = 0;
const mobile = () => `934${String(seq++).padStart(7, '0')}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDate(new Date(Date.now() - n * 86400000));

async function otpLogin(m: string) {
  const app = await getApp();
  const device = newDevice();
  const ch = await request(app).post('/api/auth/otp/request').send({ mobile: m, device });
  const res = await request(app)
    .post('/api/auth/otp/verify')
    .send({ challengeId: ch.body.challengeId, code: lastOtpFor(m), device });
  expect(res.body.status).toBe('authenticated');
  return res.body.accessToken as string;
}

describe('cross-module integration', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let branchId: number;
  let teacherUserId: number;
  let batchId: number;
  let courseId: number;
  let student: { id: number; userId: number; name: string };
  let parentMobile: string;
  let parent: string;

  beforeAll(async () => {
    app = await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;

    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const teacherRole = roles.body.find((r: { slug: string }) => r.slug === 'teacher');
    const tMobile = mobile();
    const t = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({
        name: 'Integration Teacher',
        mobile: tMobile,
        password: 'Teacher@12345',
        roles: [{ roleId: teacherRole.id, branchId: null }],
        branchIds: [branchId],
      });
    expect(t.status).toBe(201);
    teacherUserId = t.body.id;
    teacher = (await login({ mobile: tMobile, password: 'Teacher@12345' })).accessToken;

    const session = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: 'INT 2020-50', startDate: '2020-01-01', endDate: '2050-12-31' });
    expect(session.status).toBe(201);
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: 'Integration Course', code: 'INT-C1', branchIds: [branchId] });
    expect(course.status).toBe(201);
    courseId = course.body.id;
    const batch = await request(app)
      .post('/api/academics/batches')
      .set(bearer(admin))
      .send({
        branchId,
        courseId,
        academicSessionId: session.body.id,
        name: 'Integration Batch',
        code: 'INT-B1',
        capacity: 1,
        startDate: '2020-01-01',
        status: 'active',
        teachers: [{ teacherUserId }],
      });
    expect(batch.status).toBe(201);
    batchId = batch.body.id;
  });

  it('admission with a batch enrols the student through academics and confirms to them', async () => {
    const appl = await request(app)
      .post('/api/admissions/applications')
      .set(bearer(admin))
      .send({ name: 'Admitted Kid', mobile: mobile(), branchId, batchId });
    expect(appl.status).toBe(201);
    expect(appl.body.courseId).toBe(courseId); // defaulted from the batch

    const admit = await request(app)
      .post(`/api/admissions/applications/${appl.body.id}/admit`)
      .set(bearer(admin))
      .send({});
    expect(admit.status).toBe(201);
    student = admit.body.student;
    expect(student.userId).toBeTruthy();
    const row = await BatchStudent.findOne({
      where: { instituteId: 1, batchId, studentUserId: student.userId, status: 'active' },
    });
    expect(row).not.toBeNull();
    const confirmed = await NotificationMessage.findOne({
      where: { instituteId: 1, userId: student.userId, eventKey: 'admissions.confirmed', channel: 'in_app' },
    });
    expect(confirmed?.body).toContain('Integration Batch');

    // Capacity 1: the next admission into the batch fails and is rolled back.
    const mFull = mobile();
    const appl2 = await request(app)
      .post('/api/admissions/applications')
      .set(bearer(admin))
      .send({ name: 'Too Late', mobile: mFull, branchId, batchId });
    const full = await request(app)
      .post(`/api/admissions/applications/${appl2.body.id}/admit`)
      .set(bearer(admin))
      .send({});
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('BATCH_FULL');
    const after = await request(app).get(`/api/admissions/applications/${appl2.body.id}`).set(bearer(admin));
    expect(after.body.status).toBe('pending');
    const search = await request(app).get('/api/students').query({ search: mFull }).set(bearer(admin));
    expect(search.body.total).toBe(0);
  });

  it('rejects an application batch that does not belong to the branch/course', async () => {
    const res = await request(app)
      .post('/api/admissions/applications')
      .set(bearer(admin))
      .send({ name: 'Wrong Batch', mobile: mobile(), branchId, batchId: 99999999 });
    expect(res.status).toBe(404);
  });

  it("delivers class changes to the student's guardian inbox", async () => {
    parentMobile = mobile();
    const link = await request(app)
      .post(`/api/students/${student.id}/guardians`)
      .set(bearer(admin))
      .send({ name: 'Integration Parent', mobile: parentMobile, relation: 'mother' });
    expect(link.status).toBe(201);
    parent = await otpLogin(parentMobile);

    const cls = await request(app)
      .post('/api/academics/class-sessions')
      .set(bearer(admin))
      .send({ batchId, teacherUserId, date: '2049-06-01', startTime: '10:00', endTime: '11:00' });
    expect(cls.status).toBe(201);
    const cancel = await request(app)
      .post(`/api/academics/class-sessions/${cls.body.id}/cancel`)
      .set(bearer(admin))
      .send({ reason: 'Teacher unwell' });
    expect(cancel.status).toBe(200);
    await processDueJobs();

    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(parent));
    expect(inbox.status).toBe(200);
    expect(inbox.body.items.map((i: { eventKey: string }) => i.eventKey)).toContain('classes.cancelled');
  });

  it('lets a parent file a grievance for their linked child (real guardians resolver)', async () => {
    const linked = await request(app).get('/api/grievances/linked-students').set(bearer(parent));
    expect(linked.status).toBe(200);
    expect(linked.body).toEqual([{ id: student.userId, name: student.name }]);

    const cats = await request(app).get('/api/grievances/categories').set(bearer(admin));
    const ticket = await request(app).post('/api/grievances').set(bearer(parent)).send({
      categoryId: cats.body[0].id,
      subject: 'Bus timing',
      description: 'The bus is late every day',
      onBehalfOfUserId: student.userId,
    });
    expect(ticket.status).toBe(201);
    expect(ticket.body).toMatchObject({ requesterType: 'parent', onBehalfOf: { id: student.userId } });
  });

  it('turns completed classes into idempotent payroll lecture units', async () => {
    const emp = await request(app)
      .post('/api/hr/employees')
      .set(bearer(admin))
      .send({ userId: teacherUserId, dateOfJoining: '2020-01-01' });
    expect(emp.status).toBe(201);
    expect(emp.body.isTeacher).toBe(true);

    const cls = await request(app)
      .post('/api/academics/class-sessions')
      .set(bearer(admin))
      .send({ batchId, teacherUserId, date: daysAgo(1), startTime: '07:00', endTime: '08:00' });
    expect(cls.status).toBe(201);
    const complete = () =>
      request(app)
        .post(`/api/academics/class-sessions/${cls.body.id}/complete`)
        .set(bearer(teacher))
        .send({ actualDurationMinutes: 55 });
    expect((await complete()).status).toBe(200);
    await processDueJobs();
    expect((await complete()).status).toBe(200);
    await processDueJobs();

    const units = await WorkUnit.findAll({
      where: { instituteId: 1, externalRef: `academics:class-session:${cls.body.id}` },
    });
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ employeeId: emp.body.id, unitType: 'lecture', date: daysAgo(1) });
  });

  it("enforces the plan's maxTeachers on HR employees", async () => {
    const zenith = (await login(USERS.zenithAdmin)).accessToken;
    const sub = (await Subscription.findOne({ where: { instituteId: 2 }, order: [['id', 'DESC']] }))!;
    const teachers = await Employee.count({ where: { instituteId: 2, isTeacher: true } });
    await sub.update({ limitOverrides: { maxTeachers: teachers } });
    try {
      const blocked = await request(app)
        .post('/api/hr/employees')
        .set(bearer(zenith))
        .send({ name: 'One Too Many', dateOfJoining: '2024-01-01', isTeacher: true });
      expect(blocked.status).toBe(402);
      expect(blocked.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');

      const staff = await request(app)
        .post('/api/hr/employees')
        .set(bearer(zenith))
        .send({ name: 'Front Desk', dateOfJoining: '2024-01-01' });
      expect(staff.status).toBe(201);
      const promote = await request(app)
        .patch(`/api/hr/employees/${staff.body.id}`)
        .set(bearer(zenith))
        .send({ isTeacher: true });
      expect(promote.status).toBe(402);
    } finally {
      await sub.update({ limitOverrides: null });
    }
  });
});
