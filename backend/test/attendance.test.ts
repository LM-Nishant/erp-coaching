import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { runWithContext } from '../src/shared/context';
import { Branch } from '../src/modules/branches/branch.model';
import { User } from '../src/modules/users/user.model';
import {
  AcademicSession,
  Batch,
  BatchStudent,
  ClassSession,
  Course,
  Subject,
} from '../src/modules/academics/models';
import { recordAttendance } from '../src/modules/attendance/api';
import { DEMO_PASSWORD, USERS, bearer, getApp, lastOtpFor, login, newDevice } from './helpers';

let seq = 0;
const mobile = () => `936${String(seq++).padStart(7, '0')}`;

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

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

describe('attendance module', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let zenith: string;
  let accountant: string;
  let s1: string; // student 1 (has a parent)
  let s2: string;
  let parent: string;
  let parentMobile: string;
  let branchId: number;
  let teacherId: number;
  const u: Record<string, number> = {};
  const ids: Record<string, number> = {};
  const today = localDate();

  beforeAll(async () => {
    app = await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    // A fresh accountant (the seeded one's device history belongs to the auth tests).
    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const accountantRole = roles.body.find((r: { slug: string }) => r.slug === 'accountant');
    const aMobile = mobile();
    const acc = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({
        name: 'Attendance Accountant',
        mobile: aMobile,
        password: DEMO_PASSWORD,
        roles: [{ roleId: accountantRole.id, branchId: null }],
        branchIds: [branchId],
      });
    expect(acc.status).toBe(201);
    accountant = (await login({ mobile: aMobile, password: DEMO_PASSWORD })).accessToken;
    teacherId = (await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } }))!.id;

    // Two students with logins; the first has a linked parent.
    const m1 = mobile();
    const m2 = mobile();
    for (const [key, m, name] of [
      ['s1', m1, 'Asha Attendance'],
      ['s2', m2, 'Bala Attendance'],
    ] as const) {
      const r = await request(app)
        .post('/api/students')
        .set(bearer(admin))
        .send({ name, mobile: m, branchId });
      expect(r.status).toBe(201);
      u[key] = r.body.userId;
      ids[`${key}Student`] = r.body.id;
    }
    parentMobile = mobile();
    const link = await request(app)
      .post(`/api/students/${ids.s1Student}/guardians`)
      .set(bearer(admin))
      .send({ name: 'Parent Attendance', mobile: parentMobile, relation: 'mother' });
    expect(link.status).toBe(201);
    s1 = await otpLogin(m1);
    s2 = await otpLogin(m2);
    parent = await otpLogin(parentMobile);

    // Academics: session, subject, course, batch with the teacher, both students enrolled.
    const sess = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: 'ATT-2040', startDate: '2020-04-01', endDate: '2040-03-31' });
    expect(sess.status).toBe(201);
    ids.session = sess.body.id;
    const subject = await request(app)
      .post('/api/academics/subjects')
      .set(bearer(admin))
      .send({ name: 'Attendance Maths', code: 'ATT-MAT' });
    expect(subject.status).toBe(201);
    ids.subject = subject.body.id;
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: 'Attendance Course', code: 'ATT-C', subjectIds: [ids.subject], branchIds: [branchId] });
    expect(course.status).toBe(201);
    ids.course = course.body.id;
    const batch = await request(app)
      .post('/api/academics/batches')
      .set(bearer(admin))
      .send({
        branchId,
        courseId: course.body.id,
        academicSessionId: sess.body.id,
        name: 'ATT Morning',
        code: 'ATT-M',
        capacity: 30,
        startDate: '2020-04-01',
        teachers: [{ teacherUserId: teacherId, subjectId: ids.subject }],
      });
    expect(batch.status).toBe(201);
    ids.batch = batch.body.id;
    const enroll = await request(app)
      .post(`/api/academics/batches/${ids.batch}/students`)
      .set(bearer(admin))
      .send({ studentUserIds: [u.s1, u.s2], joinedOn: localDate(new Date(Date.now() - 30 * 86400000)) });
    expect(enroll.status).toBe(201);

    // A class happening right now, and one from yesterday.
    const now = new Date();
    const start = Math.min(Math.max(now.getHours() * 60 + now.getMinutes() - 2, 0), 22 * 60);
    const cls = await request(app)
      .post('/api/academics/class-sessions')
      .set(bearer(admin))
      .send({
        batchId: ids.batch,
        subjectId: ids.subject,
        teacherUserId: teacherId,
        date: today,
        startTime: hhmm(start),
        endTime: hhmm(start + 60),
      });
    expect(cls.status).toBe(201);
    ids.cls = cls.body.id;
    const past = await request(app)
      .post('/api/academics/class-sessions')
      .set(bearer(admin))
      .send({
        batchId: ids.batch,
        subjectId: ids.subject,
        teacherUserId: teacherId,
        date: addDays(today, -1),
        startTime: '06:00',
        endTime: '07:00',
      });
    expect(past.status).toBe(201);
    ids.past = past.body.id;
  });

  // Remove the academics fixtures: the academics tests expect Apex to start without academic sessions.
  afterAll(async () => {
    const where = { instituteId: 1 };
    if (ids.batch) {
      await ClassSession.destroy({ where: { ...where, batchId: ids.batch } });
      await BatchStudent.destroy({ where: { ...where, batchId: ids.batch } });
      await Batch.destroy({ where: { ...where, id: ids.batch } });
    }
    if (ids.course) await Course.destroy({ where: { ...where, id: ids.course } });
    if (ids.subject) await Subject.destroy({ where: { ...where, id: ids.subject } });
    if (ids.session) await AcademicSession.destroy({ where: { ...where, id: ids.session } });
  });

  it('lists the teacher day and opens a roster for the class', async () => {
    const day = await request(app).get(`/api/attendance/day?date=${today}`).set(bearer(teacher));
    expect(day.status).toBe(200);
    expect(day.body.items.some((i: { classSessionId: number }) => i.classSessionId === ids.cls)).toBe(true);

    const open = await request(app)
      .post('/api/attendance/sessions')
      .set(bearer(teacher))
      .send({ classSessionId: ids.cls, instituteId: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    expect(open.body.session).toMatchObject({ kind: 'class', status: 'open', classSessionId: ids.cls });
    expect(open.body.roster.map((r: { studentUserId: number }) => r.studentUserId).sort()).toEqual(
      [u.s1, u.s2].sort(),
    );
    ids.att = open.body.session.id;
    // Opening again returns the same session.
    const again = await request(app)
      .post('/api/attendance/sessions')
      .set(bearer(admin))
      .send({ classSessionId: ids.cls });
    expect(again.body.session.id).toBe(ids.att);
  });

  it('enforces permissions and tenant isolation', async () => {
    expect((await request(app).get('/api/attendance/day').set(bearer(s1))).status).toBe(403);
    expect(
      (
        await request(app)
          .put(`/api/attendance/sessions/${ids.att}/records`)
          .set(bearer(accountant))
          .send({ records: [{ studentUserId: u.s1, status: 'present' }] })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/attendance/sessions/${ids.att}`).set(bearer(accountant))).status,
    ).toBe(200);
    expect((await request(app).get(`/api/attendance/sessions/${ids.att}`).set(bearer(zenith))).status).toBe(
      404,
    );
    expect(
      (
        await request(app)
          .put(`/api/attendance/sessions/${ids.att}/records`)
          .set(bearer(zenith))
          .send({ records: [{ studentUserId: u.s1, status: 'present' }] })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/api/attendance/sessions')
          .set(bearer(zenith))
          .send({ classSessionId: ids.cls })
      ).status,
    ).toBe(404);
    const zDay = await request(app).get(`/api/attendance/day?date=${today}`).set(bearer(zenith));
    expect(zDay.body.items).toEqual([]);
  });

  it('checks a student in with a rotating QR code and rejects duplicates and forged tokens', async () => {
    expect((await request(app).get(`/api/attendance/sessions/${ids.att}/qr`).set(bearer(s1))).status).toBe(
      403,
    );
    const qr = await request(app).get(`/api/attendance/sessions/${ids.att}/qr`).set(bearer(teacher));
    expect(qr.status).toBe(200);
    expect(qr.body.token).toMatch(/^att1\./);

    const forged = qr.body.token.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
    const bad = await request(app)
      .post('/api/attendance/check-in')
      .set(bearer(s1))
      .send({ method: 'qr', token: forged });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('QR_INVALID');

    const ok = await request(app)
      .post('/api/attendance/check-in')
      .set(bearer(s1))
      .send({ method: 'qr', token: qr.body.token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'present', duplicate: false, sessionId: ids.att });
    const dup = await request(app)
      .post('/api/attendance/check-in')
      .set(bearer(s1))
      .send({ method: 'qr', token: qr.body.token });
    expect(dup.body.duplicate).toBe(true);

    // An Apex token is meaningless in Zenith.
    const cross = await request(app)
      .post('/api/attendance/check-in')
      .set(bearer(zenith))
      .send({ method: 'qr', token: qr.body.token });
    expect(cross.body.error.code).toBe('QR_INVALID');
  });

  it('checks in from mobile within the window and enforces the geofence when required', async () => {
    const opts = await request(app).get('/api/attendance/me/check-in-options').set(bearer(s2));
    expect(opts.status).toBe(200);
    const item = opts.body.items.find((i: { classSessionId: number }) => i.classSessionId === ids.cls);
    expect(item.canCheckIn).toBe(true);

    await request(app)
      .put('/api/attendance/settings')
      .set(bearer(admin))
      .send({ requireGeofence: true, geofences: { [branchId]: { lat: 12.97, lng: 77.59, radiusM: 200 } } });
    const far = await request(app)
      .post('/api/attendance/check-in')
      .set(bearer(s2))
      .send({ method: 'mobile', classSessionId: ids.cls, lat: 13.5, lng: 77.59 });
    expect(far.status).toBe(403);
    expect(far.body.error.code).toBe('OUT_OF_GEOFENCE');
    const near = await request(app)
      .post('/api/attendance/check-in')
      .set(bearer(s2))
      .send({ method: 'mobile', classSessionId: ids.cls, lat: 12.9701, lng: 77.5901 });
    expect(near.status).toBe(200);
    expect(near.body.status).toBe('present');
    await request(app).put('/api/attendance/settings').set(bearer(admin)).send({ requireGeofence: false });

    // Past class: outside the window.
    const late = await request(app)
      .post('/api/attendance/check-in')
      .set(bearer(s2))
      .send({ method: 'mobile', classSessionId: ids.past });
    expect(late.status).toBe(409);
  });

  it('lets the teacher override marks and closes the roster, alerting parents of absentees', async () => {
    const mark = await request(app)
      .put(`/api/attendance/sessions/${ids.att}/records`)
      .set(bearer(teacher))
      .send({ records: [{ studentUserId: u.s2, status: 'late', remarks: 'Bus delay' }] });
    expect(mark.status).toBe(200);
    expect(mark.body.roster.find((r: { studentUserId: number }) => r.studentUserId === u.s2)).toMatchObject({
      status: 'late',
      source: 'manual',
    });
    const notOnRoster = await request(app)
      .put(`/api/attendance/sessions/${ids.att}/records`)
      .set(bearer(teacher))
      .send({ records: [{ studentUserId: teacherId, status: 'present' }] });
    expect(notOnRoster.status).toBe(400);

    // Past class: nobody marked → closing makes everyone absent and alerts the s1 parent once.
    const past = await request(app)
      .post('/api/attendance/sessions')
      .set(bearer(teacher))
      .send({ classSessionId: ids.past });
    ids.attPast = past.body.session.id;
    const inbox = async () =>
      (await request(app).get('/api/notifications/inbox').set(bearer(parent))).body.items.filter(
        (m: { eventKey: string }) => m.eventKey === 'attendance.absent',
      ).length;
    const before = await inbox();
    const closed = await request(app)
      .post(`/api/attendance/sessions/${ids.attPast}/close`)
      .set(bearer(teacher));
    expect(closed.status).toBe(200);
    expect(closed.body.session.status).toBe('closed');
    expect(closed.body.roster).toHaveLength(2);
    expect(closed.body.roster.every((r: { status: string }) => r.status === 'absent')).toBe(true);
    await processDueJobs(200);
    expect(await inbox()).toBe(before + 1);
    // Re-close / retries don't alert twice.
    await request(app).post(`/api/attendance/sessions/${ids.attPast}/close`).set(bearer(teacher));
    await processDueJobs(200);
    expect(await inbox()).toBe(before + 1);

    // Closed: teacher can no longer edit directly; admin can.
    const locked = await request(app)
      .put(`/api/attendance/sessions/${ids.attPast}/records`)
      .set(bearer(teacher))
      .send({ records: [{ studentUserId: u.s2, status: 'present' }] });
    expect(locked.status).toBe(409);
  });

  it('runs correction requests through teacher approval', async () => {
    const req1 = await request(app)
      .post('/api/attendance/me/corrections')
      .set(bearer(s1))
      .send({ attendanceSessionId: ids.attPast, requestedStatus: 'present', reason: 'I was in class' });
    expect(req1.status).toBe(201);
    expect(req1.body).toMatchObject({
      status: 'pending',
      currentStatus: 'absent',
      requestedStatus: 'present',
    });
    const dup = await request(app)
      .post('/api/attendance/me/corrections')
      .set(bearer(s1))
      .send({ attendanceSessionId: ids.attPast, requestedStatus: 'present', reason: 'Again' });
    expect(dup.status).toBe(409);
    // s2 cannot correct for s1.
    const other = await request(app)
      .post('/api/attendance/me/corrections')
      .set(bearer(s2))
      .send({
        attendanceSessionId: ids.attPast,
        studentUserId: u.s1,
        requestedStatus: 'present',
        reason: 'x'.repeat(5),
      });
    expect(other.status).toBe(404);

    const list = await request(app).get('/api/attendance/corrections?status=pending').set(bearer(teacher));
    expect(list.body.items.some((c: { id: number }) => c.id === req1.body.id)).toBe(true);
    expect(
      (
        await request(app)
          .post(`/api/attendance/corrections/${req1.body.id}/decide`)
          .set(bearer(zenith))
          .send({ approve: true })
      ).status,
    ).toBe(404);
    const decided = await request(app)
      .post(`/api/attendance/corrections/${req1.body.id}/decide`)
      .set(bearer(teacher))
      .send({ approve: true, note: 'Verified' });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe('approved');
    const roster = await request(app).get(`/api/attendance/sessions/${ids.attPast}`).set(bearer(admin));
    expect(roster.body.roster.find((r: { studentUserId: number }) => r.studentUserId === u.s1)).toMatchObject(
      {
        status: 'present',
        source: 'correction',
      },
    );

    // Parent raises one for their child.
    const byParent = await request(app).post('/api/attendance/me/corrections').set(bearer(parent)).send({
      attendanceSessionId: ids.att,
      studentUserId: u.s1,
      requestedStatus: 'late',
      reason: 'Arrived late',
    });
    expect(byParent.status).toBe(201);
    const mine = await request(app).get('/api/attendance/me/corrections').set(bearer(parent));
    expect(mine.body.some((c: { id: number }) => c.id === byParent.body.id)).toBe(true);
    const cancel = await request(app)
      .post(`/api/attendance/me/corrections/${byParent.body.id}/cancel`)
      .set(bearer(parent));
    expect(cancel.body.status).toBe('cancelled');
  });

  it('approves student leave and converts absences', async () => {
    const leave = await request(app)
      .post('/api/attendance/me/leaves')
      .set(bearer(parent))
      .send({
        studentUserId: u.s1,
        fromDate: addDays(today, -1),
        toDate: addDays(today, -1),
        reason: 'Fever',
      });
    expect(leave.status).toBe(201);
    const overlap = await request(app)
      .post('/api/attendance/me/leaves')
      .set(bearer(s1))
      .send({ fromDate: addDays(today, -2), toDate: addDays(today, -1), reason: 'Overlap' });
    expect(overlap.status).toBe(409);

    // s1 is present (correction) for yesterday; s2 absent. Leave for s2:
    const l2 = await request(app)
      .post('/api/attendance/me/leaves')
      .set(bearer(s2))
      .send({ fromDate: addDays(today, -1), toDate: addDays(today, -1), reason: 'Family function' });
    expect(l2.status).toBe(201);
    expect(
      (
        await request(app)
          .post(`/api/attendance/leaves/${l2.body.id}/decide`)
          .set(bearer(teacher))
          .send({ approve: true })
      ).status,
    ).toBe(403);
    const ok = await request(app)
      .post(`/api/attendance/leaves/${l2.body.id}/decide`)
      .set(bearer(admin))
      .send({ approve: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', convertedRecords: 1 });
    const rejected = await request(app)
      .post(`/api/attendance/leaves/${leave.body.id}/decide`)
      .set(bearer(admin))
      .send({ approve: false, note: 'Already present' });
    expect(rejected.body.status).toBe('rejected');
  });

  it('records attendance from other modules via recordAttendance()', async () => {
    const res = await runWithContext(
      { requestId: 'test', system: true, instituteId: 1, allowedBranchIds: null },
      () => recordAttendance({ classSessionId: ids.cls, studentUserId: u.s1, source: 'live' }),
    );
    expect(res).toMatchObject({ attendanceSessionId: ids.att, duplicate: true, status: 'present' });
    await expect(
      runWithContext({ requestId: 'test', system: true, instituteId: 2, allowedBranchIds: null }, () =>
        recordAttendance({ classSessionId: ids.cls, studentUserId: u.s1 }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('ingests biometric device pushes with dedupe', async () => {
    const dev = await request(app)
      .post('/api/attendance/devices')
      .set(bearer(admin))
      .send({ name: 'Gate 1', serial: 'ATT-DEV-1', branchId });
    expect(dev.status).toBe(201);
    expect(dev.body.apiKey).toBeTruthy();
    expect((await request(app).get('/api/attendance/devices').set(bearer(teacher))).status).toBe(403);
    expect((await request(app).get('/api/attendance/devices').set(bearer(zenith))).body).toEqual([]);
    const enr = await request(app)
      .put('/api/attendance/enrolments')
      .set(bearer(admin))
      .send({ studentUserId: u.s1, enrolmentId: 'E-101' });
    expect(enr.status).toBe(200);

    const punchedAt = new Date().toISOString();
    const body = [
      { deviceSerial: 'ATT-DEV-1', enrolmentId: 'E-101', punchedAt },
      { deviceSerial: 'ATT-DEV-1', enrolmentId: 'E-999', punchedAt },
    ];
    const noKey = await request(app)
      .post('/api/attendance/public/device-events')
      .set({ 'X-Device-Serial': 'ATT-DEV-1', 'X-Device-Key': 'wrong' })
      .send(body);
    expect(noKey.status).toBe(401);
    const push = await request(app)
      .post('/api/attendance/public/device-events')
      .set({ 'X-Device-Serial': 'ATT-DEV-1', 'X-Device-Key': dev.body.apiKey })
      .send(body);
    expect(push.status).toBe(200);
    // s1 already checked in by QR → duplicate; unknown enrolment → unmatched.
    expect(push.body).toMatchObject({ received: 2, applied: 0, duplicate: 1, unmatched: 1 });
    const again = await request(app)
      .post('/api/attendance/public/device-events')
      .set({ 'X-Device-Serial': 'ATT-DEV-1', 'X-Device-Key': dev.body.apiKey })
      .send(body);
    expect(again.body).toMatchObject({ received: 2, duplicate: 2, unmatched: 0 });

    const events = await request(app).get('/api/attendance/device-events').set(bearer(admin));
    expect(events.body.total).toBe(2);
    expect((await request(app).get('/api/attendance/device-events').set(bearer(zenith))).body.total).toBe(0);
  });

  it('reports percentages for students, batches and branches and exports CSV', async () => {
    const q = `from=${addDays(today, -7)}&to=${today}`;
    const students = await request(app)
      .get(`/api/attendance/reports/students?${q}&batchId=${ids.batch}`)
      .set(bearer(accountant));
    expect(students.status).toBe(200);
    const a = students.body.find((r: { studentUserId: number }) => r.studentUserId === u.s1);
    const b = students.body.find((r: { studentUserId: number }) => r.studentUserId === u.s2);
    expect(a).toMatchObject({ present: 2, total: 2, percentage: 100, belowThreshold: false });
    // s2: late today + leave yesterday (excluded from the denominator).
    expect(b).toMatchObject({ late: 1, leave: 1, total: 1, percentage: 100 });

    const batches = await request(app).get(`/api/attendance/reports/batches?${q}`).set(bearer(admin));
    expect(batches.body.find((r: { id: number }) => r.id === ids.batch)).toMatchObject({
      students: 2,
      total: 3,
    });
    const branches = await request(app).get(`/api/attendance/reports/branches?${q}`).set(bearer(admin));
    expect(branches.body.find((r: { id: number }) => r.id === branchId).students).toBeGreaterThanOrEqual(2);

    const csv = await request(app).get(`/api/attendance/reports/students?${q}&format=csv`).set(bearer(admin));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Asha Attendance');
    expect(
      (await request(app).get(`/api/attendance/reports/students?${q}&format=csv`).set(bearer(teacher)))
        .status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/attendance/reports/students?${q}`).set(bearer(zenith))).body,
    ).toEqual([]);
  });

  it('shows students and parents their monthly and annual attendance', async () => {
    const year = Number(today.slice(0, 4));
    const mine = await request(app).get(`/api/attendance/me/summary?year=${year}`).set(bearer(s1));
    expect(mine.status).toBe(200);
    expect(mine.body.overall.percentage).toBe(100);
    expect(mine.body.records.length).toBeGreaterThanOrEqual(1);

    const children = await request(app).get('/api/attendance/me/children').set(bearer(parent));
    expect(children.body).toEqual([{ studentUserId: u.s1, name: 'Asha Attendance' }]);
    const child = await request(app)
      .get(`/api/attendance/me/children/${u.s1}/summary?year=${year}`)
      .set(bearer(parent));
    expect(child.status).toBe(200);
    expect(child.body.studentUserId).toBe(u.s1);
    expect(
      (await request(app).get(`/api/attendance/me/children/${u.s2}/summary`).set(bearer(parent))).status,
    ).toBe(404);
    expect((await request(app).get('/api/attendance/me/summary').set(bearer(teacher))).status).toBe(403);
  });

  it('closes open attendance when the class is completed', async () => {
    const done = await request(app)
      .post(`/api/academics/class-sessions/${ids.cls}/complete`)
      .set(bearer(teacher))
      .send({ actualDurationMinutes: 60 });
    expect(done.status).toBe(200);
    await processDueJobs(200);
    const s = await request(app).get(`/api/attendance/sessions/${ids.att}`).set(bearer(admin));
    expect(s.body.session.status).toBe('closed');
  });
});
