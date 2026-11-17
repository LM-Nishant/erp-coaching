import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { Job } from '../src/infrastructure/jobs/job.model';
import { mockCalendarProvider } from '../src/infrastructure/calendar';
import { runWithContext } from '../src/shared/context';
import { Branch } from '../src/modules/branches/branch.model';
import { User } from '../src/modules/users/user.model';
import { AcademicSession, ClassSession } from '../src/modules/academics/api';
import { Appointment } from '../src/modules/appointments/appointments.models';
import { USERS, bearer, getApp, lastOtpFor, login, newDevice } from './helpers';

let seq = 0;
const mobile = () => `939${String(seq++).padStart(7, '0')}`;
const OTHER_TEACHER = { mobile: '9100000941', password: 'Password@123' };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const daysAhead = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
};
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const asApex = <T>(fn: () => Promise<T>) =>
  runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, fn);

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

describe('appointments + parent portal', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let otherTeacher: string;
  let zenith: string;
  let parent: string;
  let strangerParent: string;
  let branchId: number;
  let teacherId: number;
  let otherTeacherId: number;
  let batchId: number;
  let child: { id: number; userId: number };
  let unlinked: { id: number; userId: number };
  let slotId: number;
  let apptId: number;
  // A weekday a week from now: far enough ahead for both reminder leads.
  const DAY = daysAhead(7);

  const student = async (name: string) => {
    const r = await request(app).post('/api/students').set(bearer(admin)).send({ name, mobile: mobile() });
    expect(r.status).toBe(201);
    return r.body as { id: number; userId: number };
  };
  const link = async (studentId: number, m: string) => {
    const r = await request(app)
      .post(`/api/students/${studentId}/guardians`)
      .set(bearer(admin))
      .send({ name: 'Parent Appt', mobile: m, relation: 'mother' });
    expect(r.status).toBe(201);
  };

  // Other suites share this DB and assume they own institute 1's academic data (e.g. "the first session is
  // current", per-teacher class counts), so remove our academic fixtures once done.
  let fixture: { sessionId?: number; courseId?: number } = {};
  afterAll(async () => {
    const q = (sql: string, id?: number) =>
      id ? Appointment.sequelize!.query(sql, { replacements: [id] }) : Promise.resolve();
    await q('DELETE FROM class_sessions WHERE batch_id = ?', batchId);
    await q('DELETE FROM batch_students WHERE batch_id = ?', batchId);
    await q('DELETE FROM batch_teachers WHERE batch_id = ?', batchId);
    await q('DELETE FROM batches WHERE id = ?', batchId);
    await q('DELETE FROM course_branches WHERE course_id = ?', fixture.courseId);
    await q('DELETE FROM courses WHERE id = ?', fixture.courseId);
    await q('DELETE FROM academic_sessions WHERE id = ?', fixture.sessionId);
  });

  beforeAll(async () => {
    app = await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    teacherId = (await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } }))!.id;

    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const teacherRole = roles.body.find((r: { slug: string }) => r.slug === 'teacher');
    const created = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({
        name: 'Other Teacher',
        mobile: OTHER_TEACHER.mobile,
        password: OTHER_TEACHER.password,
        roles: [{ roleId: teacherRole.id, branchId: null }],
        branchIds: [branchId],
      });
    expect(created.status).toBe(201);
    otherTeacherId = created.body.id;
    otherTeacher = (await login(OTHER_TEACHER)).accessToken;

    // Academic fixtures: a (non-current) session, a course and a batch taught by the seeded teacher.
    const session = await asApex(() =>
      AcademicSession.create({
        instituteId: 1,
        name: 'APPT 2050',
        startDate: '2050-04-01',
        endDate: '2051-03-31',
      }),
    );
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: 'Appt Course', code: 'APPT-C', branchIds: [branchId] });
    expect(course.status).toBe(201);
    fixture = { sessionId: session.id, courseId: course.body.id };
    const batch = await request(app)
      .post('/api/academics/batches')
      .set(bearer(admin))
      .send({
        branchId,
        courseId: course.body.id,
        academicSessionId: session.id,
        name: 'Appt Batch',
        code: 'APPT-B',
        capacity: 10,
        startDate: '2026-01-01',
        teachers: [{ teacherUserId: teacherId }],
      });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    batchId = batch.body.id;

    child = await student('Appt Child');
    unlinked = await student('Appt Other Child');
    const enroll = await request(app)
      .post(`/api/academics/batches/${batchId}/students`)
      .set(bearer(admin))
      .send({ studentUserIds: [child.userId, unlinked.userId] });
    expect(enroll.status).toBe(201);
    const pm = mobile();
    await link(child.id, pm);
    parent = await otpLogin(pm);
    const sm = mobile();
    await link(unlinked.id, sm);
    strangerParent = await otpLogin(sm);

    await asApex(() =>
      ClassSession.create({
        instituteId: 1,
        branchId,
        batchId,
        subjectId: null,
        scheduleId: null,
        teacherUserId: teacherId,
        classroomId: null,
        date: DAY,
        startTime: '09:00',
        endTime: '10:00',
      }),
    );
  });

  // ------------------------------------------------------------ availability

  it('lets teachers manage their own availability slots', async () => {
    const bad = await request(app)
      .post('/api/appointments/slots')
      .set(bearer(teacher))
      .send({ branchId, kind: 'recurring', startTime: '16:00', endTime: '17:00' });
    expect(bad.status).toBe(400);
    const res = await request(app)
      .post('/api/appointments/slots')
      .set(bearer(teacher))
      .send({
        branchId,
        kind: 'recurring',
        dayOfWeek: dow(DAY),
        startTime: '16:00',
        endTime: '17:00',
        slotMinutes: 20,
        mode: 'both',
        location: 'Room 4',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      teacherUserId: teacherId,
      startTime: '16:00',
      slotMinutes: 20,
      mode: 'both',
    });
    slotId = res.body.id;

    const oneOff = await request(app).post('/api/appointments/slots').set(bearer(teacher)).send({
      branchId,
      kind: 'one_off',
      date: DAY,
      startTime: '18:00',
      endTime: '18:30',
      slotMinutes: 30,
      mode: 'online',
    });
    expect(oneOff.status).toBe(201);
    const patched = await request(app)
      .patch(`/api/appointments/slots/${oneOff.body.id}`)
      .set(bearer(teacher))
      .send({ endTime: '19:00' });
    expect(patched.body.endTime).toBe('19:00');

    // Another teacher can neither see nor edit it; nor create slots for someone else.
    expect(
      (
        await request(app)
          .patch(`/api/appointments/slots/${slotId}`)
          .set(bearer(otherTeacher))
          .send({ isActive: false })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app).post('/api/appointments/slots').set(bearer(otherTeacher)).send({
          branchId,
          teacherUserId: teacherId,
          kind: 'one_off',
          date: DAY,
          startTime: '10:00',
          endTime: '11:00',
        })
      ).status,
    ).toBe(403);
    const mine = await request(app).get('/api/appointments/slots').set(bearer(teacher));
    expect(mine.body.map((s: { id: number }) => s.id)).toEqual(
      expect.arrayContaining([slotId, oneOff.body.id]),
    );
    expect((await request(app).get('/api/appointments/slots').set(bearer(otherTeacher))).body).toEqual([]);

    expect(
      (await request(app).delete(`/api/appointments/slots/${oneOff.body.id}`).set(bearer(teacher))).status,
    ).toBe(204);
    // Parents cannot manage slots.
    expect(
      (
        await request(app)
          .post('/api/appointments/slots')
          .set(bearer(parent))
          .send({ branchId, kind: 'one_off', date: DAY, startTime: '10:00', endTime: '11:00' })
      ).status,
    ).toBe(403);
  });

  it('shows parents only the teachers of their child and their free chunks', async () => {
    const teachers = await request(app)
      .get(`/api/appointments/children/${child.id}/teachers`)
      .set(bearer(parent));
    expect(teachers.status).toBe(200);
    expect(teachers.body).toEqual([
      expect.objectContaining({
        teacherUserId: teacherId,
        batches: [expect.objectContaining({ id: batchId })],
      }),
    ]);
    expect(
      (await request(app).get(`/api/appointments/children/${unlinked.id}/teachers`).set(bearer(parent)))
        .status,
    ).toBe(404);

    const avail = await request(app)
      .get(`/api/appointments/teachers/${teacherId}/availability`)
      .query({ studentId: child.id, from: DAY, to: DAY })
      .set(bearer(parent));
    expect(avail.status).toBe(200);
    expect(avail.body.map((c: { startTime: string }) => c.startTime)).toEqual(['16:00', '16:20', '16:40']);
    expect(avail.body[0].modes).toEqual(['online', 'offline']);
    // Not the child's teacher.
    expect(
      (
        await request(app)
          .get(`/api/appointments/teachers/${otherTeacherId}/availability`)
          .query({ studentId: child.id, from: DAY, to: DAY })
          .set(bearer(parent))
      ).status,
    ).toBe(400);
  });

  it('decides whether a slot is past in the institute timezone', async () => {
    // A wall-clock time just ahead of UTC now: already past in UTC+14, still ahead in UTC-11.
    const w = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 5 * 60_000).toISOString();
    const date = w.slice(0, 10);
    const startTime = w.slice(11, 16);
    const setTz = (tz: string) =>
      request(app).put('/api/institute/settings/timezone').set(bearer(admin)).send({ value: tz });
    const chunks = async () =>
      (
        await request(app)
          .get(`/api/appointments/teachers/${teacherId}/availability`)
          .query({ from: date, to: date })
          .set(bearer(admin))
      ).body.map((c: { startTime: string }) => c.startTime);
    const slot = await request(app)
      .post('/api/appointments/slots')
      .set(bearer(teacher))
      .send({
        branchId,
        kind: 'one_off',
        date,
        startTime,
        endTime: `${startTime.slice(0, 3)}35`,
        slotMinutes: 30,
        mode: 'online',
      });
    expect(slot.status, JSON.stringify(slot.body)).toBe(201);
    try {
      expect((await setTz('Not/AZone')).status).toBe(422);
      expect((await setTz('Pacific/Kiritimati')).status).toBe(200);
      expect((await request(app).get('/api/institute/settings').set(bearer(admin))).body.timezone).toBe(
        'Pacific/Kiritimati',
      );
      expect(await chunks()).not.toContain(startTime);
      expect((await setTz('Pacific/Pago_Pago')).status).toBe(200);
      expect(await chunks()).toContain(startTime);
    } finally {
      await setTz('Asia/Kolkata');
      await request(app).delete(`/api/appointments/slots/${slot.body.id}`).set(bearer(teacher));
    }
  });

  // ------------------------------------------------------------ lifecycle

  it('validates and creates a meeting request', async () => {
    const base = {
      studentId: child.id,
      teacherUserId: teacherId,
      date: DAY,
      startTime: '16:20',
      mode: 'online',
      agenda: 'Maths progress',
    };
    expect(
      (
        await request(app)
          .post('/api/appointments')
          .set(bearer(parent))
          .send({ ...base, studentId: unlinked.id })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/api/appointments')
          .set(bearer(parent))
          .send({ ...base, teacherUserId: otherTeacherId })
      ).body.error.code,
    ).toBe('NOT_CHILD_TEACHER');
    expect(
      (
        await request(app)
          .post('/api/appointments')
          .set(bearer(parent))
          .send({ ...base, startTime: '16:10' })
      ).body.error.code,
    ).toBe('SLOT_UNAVAILABLE');
    expect((await request(app).post('/api/appointments').set(bearer(teacher)).send(base)).status).toBe(403);

    const res = await request(app).post('/api/appointments').set(bearer(parent)).send(base);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'requested',
      date: DAY,
      startTime: '16:20',
      endTime: '16:40',
      mode: 'online',
      branchId,
      studentId: child.id,
    });
    expect(res.body).not.toHaveProperty('privateNotes');
    apptId = res.body.id;

    // The chunk is now taken; and only one open request per teacher+child.
    const avail = await request(app)
      .get(`/api/appointments/teachers/${teacherId}/availability`)
      .query({ studentId: child.id, from: DAY, to: DAY })
      .set(bearer(parent));
    expect(avail.body.map((c: { startTime: string }) => c.startTime)).toEqual(['16:00', '16:40']);
    expect(
      (
        await request(app)
          .post('/api/appointments')
          .set(bearer(parent))
          .send({ ...base, startTime: '16:40' })
      ).body.error.code,
    ).toBe('ALREADY_REQUESTED');
    // Another family cannot book the same chunk.
    expect(
      (
        await request(app)
          .post('/api/appointments')
          .set(bearer(strangerParent))
          .send({ ...base, studentId: unlinked.id })
      ).body.error.code,
    ).toBe('SLOT_UNAVAILABLE');

    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(teacher));
    expect(inbox.body.items.some((i: { eventKey: string }) => i.eventKey === 'appointments.requested')).toBe(
      true,
    );
  });

  it('only the involved people see the appointment', async () => {
    expect((await request(app).get(`/api/appointments/${apptId}`).set(bearer(parent))).status).toBe(200);
    expect((await request(app).get(`/api/appointments/${apptId}`).set(bearer(teacher))).status).toBe(200);
    expect((await request(app).get(`/api/appointments/${apptId}`).set(bearer(strangerParent))).status).toBe(
      404,
    );
    expect((await request(app).get(`/api/appointments/${apptId}`).set(bearer(otherTeacher))).status).toBe(
      404,
    );
    expect(
      (await request(app).post(`/api/appointments/${apptId}/approve`).set(bearer(otherTeacher)).send({}))
        .status,
    ).toBe(404);
    expect(
      (await request(app).post(`/api/appointments/${apptId}/approve`).set(bearer(parent)).send({})).status,
    ).toBe(403);
    const list = await request(app).get('/api/appointments').set(bearer(strangerParent));
    expect(list.body.items).toEqual([]);
  });

  it('approves an online meeting with a meeting link, calendar event and reminders', async () => {
    const res = await request(app)
      .post(`/api/appointments/${apptId}/approve`)
      .set(bearer(teacher))
      .send({ note: 'See you' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.meetingUrl).toMatch(/^https:\/\/meet\.mock\.invalid\//);
    const row = await Appointment.findOne({ where: { instituteId: 1, id: apptId } });
    expect(mockCalendarProvider.events.get(row!.calendarEventId!)).toMatchObject({
      withMeeting: true,
      start: `${DAY}T16:20`,
    });
    const jobs = await Job.findAll({ where: { name: 'appointments.reminder', status: 'pending' } });
    expect(
      jobs.filter((j) => (j.payload as { appointmentId: number }).appointmentId === apptId),
    ).toHaveLength(2);
    expect(
      (await request(app).post(`/api/appointments/${apptId}/approve`).set(bearer(teacher)).send({})).status,
    ).toBe(409);

    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(parent));
    expect(inbox.body.items.some((i: { eventKey: string }) => i.eventKey === 'appointments.confirmed')).toBe(
      true,
    );
  });

  it('sends reminders once and ignores stale ones after a reschedule', async () => {
    const jobs = (await Job.findAll({ where: { name: 'appointments.reminder', status: 'pending' } })).filter(
      (j) => (j.payload as { appointmentId: number }).appointmentId === apptId,
    );
    await Promise.all(jobs.map((j) => j.update({ runAt: new Date(Date.now() - 1000) })));
    await processDueJobs(50);
    const row = await Appointment.findOne({ where: { instituteId: 1, id: apptId } });
    expect(row!.lastReminderKey).toContain(`${DAY}T16:20`);
    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(parent));
    expect(
      inbox.body.items.filter((i: { eventKey: string }) => i.eventKey === 'appointments.reminder').length,
    ).toBeGreaterThanOrEqual(1);

    // Teacher reschedules to any free time: stays confirmed, link kept, new reminders.
    const r = await request(app)
      .post(`/api/appointments/${apptId}/reschedule`)
      .set(bearer(teacher))
      .send({ date: DAY, startTime: '17:30', reason: 'Clash' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'confirmed',
      startTime: '17:30',
      endTime: '17:50',
      rescheduleCount: 1,
    });
    expect(r.body.meetingUrl).toMatch(/meet\.mock\.invalid/);
    // A stale reminder for the old time is ignored.
    const { runReminder } = await import('../src/modules/appointments/appointments.service');
    const before = (await Appointment.findOne({ where: { instituteId: 1, id: apptId } }))!.lastReminderKey;
    await asApex(() => runReminder({ appointmentId: apptId, startsAt: `${DAY}T16:20`, lead: 60 }));
    expect((await Appointment.findOne({ where: { instituteId: 1, id: apptId } }))!.lastReminderKey).toBe(
      before,
    );

    // Parent reschedule must use a free chunk and goes back to the teacher.
    expect(
      (
        await request(app)
          .post(`/api/appointments/${apptId}/reschedule`)
          .set(bearer(parent))
          .send({ date: DAY, startTime: '17:30' })
      ).body.error.code,
    ).toBe('SLOT_UNAVAILABLE');
    const p = await request(app)
      .post(`/api/appointments/${apptId}/reschedule`)
      .set(bearer(parent))
      .send({ date: DAY, startTime: '16:40', mode: 'offline' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({
      status: 'requested',
      startTime: '16:40',
      mode: 'offline',
      location: 'Room 4',
      meetingUrl: null,
    });
    const ok = await request(app).post(`/api/appointments/${apptId}/approve`).set(bearer(teacher)).send({});
    expect(ok.body).toMatchObject({ status: 'confirmed', meetingUrl: null });
  });

  it('keeps private notes private and shares the summary', async () => {
    // Pretend the meeting happened.
    await Appointment.update({ date: daysAhead(-1) }, { where: { instituteId: 1, id: apptId } });
    const res = await request(app)
      .post(`/api/appointments/${apptId}/complete`)
      .set(bearer(teacher))
      .send({ sharedSummary: 'Practice more algebra', privateNotes: 'Parent seemed worried' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'completed',
      sharedSummary: 'Practice more algebra',
      privateNotes: 'Parent seemed worried',
    });
    const asParent = await request(app).get(`/api/appointments/${apptId}`).set(bearer(parent));
    expect(asParent.body.sharedSummary).toBe('Practice more algebra');
    expect(asParent.body).not.toHaveProperty('privateNotes');
    expect(asParent.body.history.map((h: { action: string }) => h.action)).toEqual(
      expect.arrayContaining(['requested', 'approved', 'reminder_sent', 'rescheduled', 'completed']),
    );
    expect(
      (
        await request(app)
          .patch(`/api/appointments/${apptId}/notes`)
          .set(bearer(parent))
          .send({ privateNotes: 'x' })
      ).status,
    ).toBe(403);
    const notes = await request(app)
      .patch(`/api/appointments/${apptId}/notes`)
      .set(bearer(teacher))
      .send({ privateNotes: 'Follow up in May' });
    expect(notes.body.privateNotes).toBe('Follow up in May');
    expect(
      (
        await request(app)
          .post(`/api/appointments/${apptId}/cancel`)
          .set(bearer(parent))
          .send({ reason: 'x' })
      ).status,
    ).toBe(409);
  });

  it('lets parents cancel and teachers reject requests', async () => {
    const r1 = await request(app).post('/api/appointments').set(bearer(parent)).send({
      studentId: child.id,
      teacherUserId: teacherId,
      date: DAY,
      startTime: '16:00',
      mode: 'offline',
    });
    expect(r1.status).toBe(201);
    const c = await request(app)
      .post(`/api/appointments/${r1.body.id}/cancel`)
      .set(bearer(parent))
      .send({ reason: 'Travelling' });
    expect(c.body).toMatchObject({ status: 'cancelled', cancelReason: 'Travelling' });
    const r2 = await request(app).post('/api/appointments').set(bearer(strangerParent)).send({
      studentId: unlinked.id,
      teacherUserId: teacherId,
      date: DAY,
      startTime: '16:00',
      mode: 'offline',
    });
    expect(r2.status).toBe(201);
    const rej = await request(app)
      .post(`/api/appointments/${r2.body.id}/reject`)
      .set(bearer(teacher))
      .send({ reason: 'On leave' });
    expect(rej.body).toMatchObject({ status: 'rejected', responseNote: 'On leave' });
    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(strangerParent));
    expect(inbox.body.items.some((i: { eventKey: string }) => i.eventKey === 'appointments.rejected')).toBe(
      true,
    );
  });

  // ------------------------------------------------------------ reports + isolation

  it('reports per branch with CSV export for staff only', async () => {
    const sum = await request(app).get('/api/appointments/reports/summary').set(bearer(admin));
    expect(sum.status).toBe(200);
    expect(sum.body.total).toBeGreaterThanOrEqual(3);
    expect(sum.body.byStatus).toMatchObject({ completed: 1, cancelled: 1, rejected: 1 });
    expect(sum.body.byBranch[0]).toMatchObject({ branchId });
    const csv = await request(app).get('/api/appointments/reports/export.csv').set(bearer(admin));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('Teacher');
    expect(csv.text).toContain('Practice more algebra');
    expect(csv.text).not.toContain('Follow up in May');
    expect((await request(app).get('/api/appointments/reports/summary').set(bearer(teacher))).status).toBe(
      403,
    );
    expect((await request(app).get('/api/appointments/reports/export.csv').set(bearer(parent))).status).toBe(
      403,
    );
    const all = await request(app).get('/api/appointments/all').set(bearer(admin));
    expect(all.body.total).toBeGreaterThanOrEqual(3);
  });

  it('isolates institutes', async () => {
    expect((await request(app).get(`/api/appointments/${apptId}`).set(bearer(zenith))).status).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/appointments/${apptId}/cancel`)
          .set(bearer(zenith))
          .send({ reason: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/appointments/slots/${slotId}`)
          .set(bearer(zenith))
          .send({ isActive: false })
      ).status,
    ).toBe(404);
    expect((await request(app).get('/api/appointments/all').set(bearer(zenith))).body.total).toBe(0);
    expect((await request(app).get('/api/appointments/reports/summary').set(bearer(zenith))).body.total).toBe(
      0,
    );
    // instituteId in the body is rejected, never honoured.
    const sneaky = await request(app)
      .post('/api/appointments/slots')
      .set(bearer(zenith))
      .send({ instituteId: 1, kind: 'one_off', date: DAY, startTime: '10:00', endTime: '11:00' });
    expect(sneaky.status).toBe(422);
    expect([403, 404]).toContain(
      (await request(app).get(`/api/parent-portal/children/${child.id}/summary`).set(bearer(zenith))).status,
    );
  });

  // ------------------------------------------------------------ parent portal

  it('serves the parent home: children, timetable and provider summaries', async () => {
    const kids = await request(app).get('/api/parent-portal/children').set(bearer(parent));
    expect(kids.status).toBe(200);
    expect(kids.body).toEqual([
      expect.objectContaining({
        studentId: child.id,
        studentUserId: child.userId,
        branchId,
        batches: [{ id: batchId, name: 'Appt Batch' }],
      }),
    ]);
    const tt = await request(app)
      .get(`/api/parent-portal/children/${child.id}/timetable`)
      .query({ from: DAY, to: DAY })
      .set(bearer(parent));
    expect(tt.status).toBe(200);
    expect(tt.body.items).toEqual([
      expect.objectContaining({ date: DAY, startTime: '09:00', batchName: 'Appt Batch' }),
    ]);
    expect(
      (await request(app).get(`/api/parent-portal/children/${unlinked.id}/timetable`).set(bearer(parent)))
        .status,
    ).toBe(404);

    const summary = await request(app)
      .get(`/api/parent-portal/children/${child.id}/summary`)
      .set(bearer(parent));
    expect(summary.status).toBe(200);
    expect(summary.body.find((s: { key: string }) => s.key === 'appointments')).toBeTruthy();
    expect((await request(app).get('/api/parent-portal/children').set(bearer(teacher))).status).toBe(403);
  });

  it('shows fees, attendance, published results and pending homework of a linked child only', async () => {
    const { FeeAccount, FeeInstalment, FeePayment } = await import('../src/modules/fees/models');
    const { AttendanceSession, AttendanceRecord } = await import('../src/modules/attendance/models');
    const { Exam, ExamAttempt } = await import('../src/modules/exams/models');
    const { LmsAssignment } = await import('../src/modules/lms/models');
    const { instituteToday } = await import('../src/shared/timezone');
    const thisMonth = (await instituteToday(1)).slice(0, 7);
    const ids: Record<string, number[]> = {};
    const track = <T extends { id: number }>(k: string, row: T) => ((ids[k] ??= []).push(row.id), row);
    try {
      await asApex(async () => {
        const account = track(
          'fee_accounts',
          await FeeAccount.create({
            instituteId: 1,
            branchId,
            studentId: child.id,
            studentUserId: child.userId,
            structureId: null,
            courseId: null,
            batchId: null,
            subjectId: null,
            academicSessionId: null,
            title: 'PP Tuition',
            gross: 1000,
            sourceRef: null,
          }),
        );
        for (const [seq, dueDate, amount] of [
          [1, daysAhead(-10), 600],
          [2, daysAhead(20), 400],
        ] as const)
          track(
            'fee_instalments',
            await FeeInstalment.create({
              instituteId: 1,
              accountId: account.id,
              seq,
              label: `PP Inst ${seq}`,
              dueDate,
              amount,
            }),
          );
        track(
          'fee_payments',
          await FeePayment.create({
            instituteId: 1,
            branchId,
            accountId: account.id,
            studentId: child.id,
            amount: 250,
            mode: 'cash',
            gateway: null,
            status: 'successful',
            referenceNo: null,
            chequeNumber: null,
            chequeDate: null,
            bankName: null,
            paidOn: daysAhead(-1),
            gatewayOrderId: null,
            idempotencyKey: null,
            bankAccountId: null,
            recordedByUserId: null,
            notes: null,
          }),
        );
        const session = track(
          'attendance_sessions',
          await AttendanceSession.create({
            instituteId: 1,
            branchId,
            batchId,
            classSessionId: null,
            sessionKey: `pp-test-${Date.now()}`,
            kind: 'daily',
            date: `${thisMonth}-01`,
            startTime: null,
            endTime: null,
            teacherUserId: null,
            qrSecret: 'x',
          }),
        );
        track(
          'attendance_records',
          await AttendanceRecord.create({
            instituteId: 1,
            branchId,
            attendanceSessionId: session.id,
            batchId,
            date: `${thisMonth}-01`,
            studentUserId: child.userId,
            status: 'present',
            source: 'manual',
            markedAt: new Date(),
            markedByUserId: null,
          }),
        );
        for (const [title, published] of [
          ['PP Published Exam', true],
          ['PP Hidden Exam', false],
        ] as const) {
          const exam = track(
            'exams',
            await Exam.create({
              instituteId: 1,
              branchId,
              title,
              description: null,
              instructions: null,
              batchId,
              courseId: null,
              subjectId: null,
              startAt: new Date(Date.now() - 86_400_000),
              endAt: new Date(Date.now() - 82_800_000),
              durationMinutes: 60,
              status: 'scheduled',
              promptVersionId: null,
              passMarks: 40,
              resultsPublishedAt: published ? new Date() : null,
              resultsPublishedBy: null,
              createdByUserId: null,
            }),
          );
          track(
            'exam_attempts',
            await ExamAttempt.create({
              instituteId: 1,
              branchId,
              examId: exam.id,
              studentUserId: child.userId,
              status: 'submitted',
              startedAt: new Date(Date.now() - 86_400_000),
              deadlineAt: new Date(Date.now() - 82_800_000),
              submittedAt: new Date(Date.now() - 83_000_000),
              lastSeenAt: null,
              questionOrder: [],
              optionOrders: null,
              totalScore: 72,
              maxScore: 100,
              rank: 1,
              percentile: null,
            }),
          );
        }
        track(
          'lms_assignments',
          await LmsAssignment.create({
            instituteId: 1,
            branchId,
            batchId,
            subjectId: null,
            chapterId: null,
            topicId: null,
            title: 'PP Homework',
            instructions: null,
            dueAt: new Date(Date.now() + 86_400_000),
            maxMarks: null,
            status: 'published',
            publishedAt: new Date(),
            createdByUserId: null,
          }),
        );
      });

      const summary = await request(app)
        .get(`/api/parent-portal/children/${child.id}/summary`)
        .set(bearer(parent));
      expect(summary.status).toBe(200);
      type Section = {
        key: string;
        metrics: { label: string; value: unknown }[];
        items: { title: string }[];
      };
      const byKey = new Map((summary.body as Section[]).map((s) => [s.key, s]));
      const fees = byKey.get('fees')!;
      expect(fees.metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Outstanding', value: '₹1,000' }),
          expect.objectContaining({ label: 'Overdue', value: '₹600' }),
          expect.objectContaining({ label: 'Next due', value: '₹400' }),
        ]),
      );
      expect(fees.items.some((i) => i.title === 'Paid ₹250')).toBe(true);
      expect(byKey.get('attendance')!.metrics[0]).toMatchObject({ label: 'This month', value: '100%' });
      const results = byKey.get('exams')!;
      expect(results.items.map((i) => i.title)).toContain('PP Published Exam');
      expect(results.items.map((i) => i.title)).not.toContain('PP Hidden Exam');
      expect(byKey.get('lms')!.items.map((i) => i.title)).toContain('PP Homework');

      // The other parent's child has none of this data; and nobody sees a child they aren't linked to.
      const other = await request(app)
        .get(`/api/parent-portal/children/${unlinked.id}/summary`)
        .set(bearer(strangerParent));
      expect(other.status).toBe(200);
      const otherKeys = (other.body as Section[]).map((s) => s.key);
      for (const k of ['fees', 'attendance', 'exams']) expect(otherKeys).not.toContain(k);
      expect(
        (other.body as Section[]).find((s) => s.key === 'lms')?.items.map((i) => i.title) ?? [],
      ).toContain('PP Homework'); // same batch → same homework, but its own submission state
      expect(
        (await request(app).get(`/api/parent-portal/children/${unlinked.id}/summary`).set(bearer(parent)))
          .status,
      ).toBe(404);
    } finally {
      for (const table of [
        'lms_assignments',
        'exam_attempts',
        'exams',
        'attendance_records',
        'attendance_sessions',
        'fee_payments',
        'fee_instalments',
        'fee_accounts',
      ])
        if (ids[table]?.length)
          await Appointment.sequelize!.query(`DELETE FROM ${table} WHERE id IN (?)`, {
            replacements: [ids[table]],
          });
    }
  });

  it('generates monthly parent reports from registered providers', async () => {
    const { registerParentPortalProvider, unregisterParentPortalProvider } =
      await import('../src/modules/parent-portal/api');
    registerParentPortalProvider({
      key: 'test-broken',
      label: 'Broken',
      module: null,
      monthlyReport: async () => {
        throw new Error('boom');
      },
    });
    registerParentPortalProvider({
      key: 'test-fees',
      label: 'Fees',
      module: null,
      order: 1,
      monthlyReport: async (c, p) => ({
        key: 'test-fees',
        label: 'Fees',
        metrics: [{ label: 'Due', value: c.name + p.period }],
        items: [],
      }),
    });
    try {
      const period = daysAhead(-1).slice(0, 7);
      expect(
        (
          await request(app)
            .post('/api/parent-portal/monthly-reports/generate')
            .set(bearer(parent))
            .send({ period })
        ).status,
      ).toBe(403);
      const gen = await request(app)
        .post('/api/parent-portal/monthly-reports/generate')
        .set(bearer(admin))
        .send({ period, studentIds: [child.id] });
      expect(gen.status).toBe(202);
      await processDueJobs(50);
      const reports = await request(app)
        .get(`/api/parent-portal/children/${child.id}/monthly-reports`)
        .set(bearer(parent));
      expect(reports.status).toBe(200);
      expect(reports.body[0]).toMatchObject({ period, studentId: child.id });
      expect(reports.body[0].sections[0]).toMatchObject({
        key: 'test-fees',
        metrics: [{ value: `Appt Child${period}` }],
      });
      expect(reports.body[0].sections.some((s: { key: string }) => s.key === 'test-broken')).toBe(false);
      expect(
        (
          await request(app)
            .get(`/api/parent-portal/children/${child.id}/monthly-reports`)
            .set(bearer(strangerParent))
        ).status,
      ).toBe(404);
      const staff = await request(app)
        .get('/api/parent-portal/monthly-reports')
        .query({ period })
        .set(bearer(admin));
      expect(staff.body.items.some((r: { studentId: number }) => r.studentId === child.id)).toBe(true);
      expect(
        (await request(app).get('/api/parent-portal/monthly-reports').set(bearer(zenith))).body.total,
      ).toBe(0);
      const inbox = await request(app).get('/api/notifications/inbox').set(bearer(parent));
      expect(
        inbox.body.items.some((i: { eventKey: string }) => i.eventKey === 'parent-portal.monthly-report'),
      ).toBe(true);
    } finally {
      unregisterParentPortalProvider('test-broken');
      unregisterParentPortalProvider('test-fees');
    }
  });
});
