import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACADEMICS_CLASS_CHANGED_JOB } from '@erp/shared';
import { Branch } from '../src/modules/branches/branch.model';
import { User } from '../src/modules/users/user.model';
import { ClassSession } from '../src/modules/academics/models';
import { getBatchMemberUserIds } from '../src/modules/academics/api';
import { runWithContext } from '../src/shared/context';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
const SUB_TEACHER = { mobile: '9100000044', password: 'Teacher@12345' };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) =>
  isoDate(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000));
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

describe('academics module', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let student: string;
  let zenith: string;
  let branchId: number;
  let branch2Id: number;
  let zenithBranchId: number;
  let teacherId: number;
  let subTeacherId: number;
  let studentId: number;

  const ids: Record<string, number> = {};
  const GEN_FROM = '2031-03-03'; // Monday
  const GEN_TO = '2031-03-30';

  beforeAll(async () => {
    app = await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    student = (await login(STUDENT)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    const branches = await Branch.findAll({ where: { instituteId: 1 }, order: [['id', 'ASC']] });
    [branchId, branch2Id] = branches.map((b) => b.id);
    zenithBranchId = (await Branch.findOne({ where: { instituteId: 2 } }))!.id;
    teacherId = (await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } }))!.id;
    studentId = (await User.findOne({ where: { mobile: STUDENT.mobile } }))!.id;

    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const teacherRole = roles.body.find((r: { slug: string }) => r.slug === 'teacher');
    const created = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({
        name: 'Substitute Teacher',
        mobile: SUB_TEACHER.mobile,
        password: SUB_TEACHER.password,
        roles: [{ roleId: teacherRole.id, branchId: null }],
        branchIds: [branchId],
      });
    expect(created.status).toBe(201);
    subTeacherId = created.body.id;
  });

  it('manages academic sessions with a single current session', async () => {
    const s1 = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: '2030-31', startDate: '2030-04-01', endDate: '2031-03-31' });
    expect(s1.status).toBe(201);
    expect(s1.body.isCurrent).toBe(true);
    const s2 = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: '2031-32', startDate: '2031-04-01', endDate: '2032-03-31' });
    expect(s2.status).toBe(201);
    expect(s2.body.isCurrent).toBe(false);
    ids.session1 = s1.body.id;
    ids.session2 = s2.body.id;

    const bad = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: 'Bad', startDate: '2031-04-01', endDate: '2030-04-01' });
    expect(bad.status).toBe(422);

    expect(
      (await request(app).post(`/api/academics/sessions/${ids.session2}/make-current`).set(bearer(admin)))
        .status,
    ).toBe(200);
    const current = await request(app).get('/api/academics/sessions/current').set(bearer(teacher));
    expect(current.body.id).toBe(ids.session2);
    await request(app).post(`/api/academics/sessions/${ids.session1}/make-current`).set(bearer(admin));
    const list = await request(app).get('/api/academics/sessions').set(bearer(admin));
    expect(list.body.filter((s: { isCurrent: boolean }) => s.isCurrent)).toHaveLength(1);
  });

  it('builds the course → subject → chapter → topic hierarchy', async () => {
    const cat = await request(app)
      .post('/api/academics/course-categories')
      .set(bearer(admin))
      .send({ name: 'Engineering' });
    expect(cat.status).toBe(201);
    const subj = await request(app)
      .post('/api/academics/subjects')
      .set(bearer(admin))
      .send({ name: 'Physics', code: 'PHY' });
    expect(subj.status).toBe(201);
    ids.subject = subj.body.id;
    const ch = await request(app)
      .post('/api/academics/chapters')
      .set(bearer(admin))
      .send({ subjectId: ids.subject, name: 'Kinematics', sortOrder: 1 });
    expect(ch.status).toBe(201);
    const topic = await request(app)
      .post('/api/academics/topics')
      .set(bearer(admin))
      .send({ chapterId: ch.body.id, name: 'Projectile motion', durationMinutes: 90 });
    expect(topic.status).toBe(201);

    const template = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({
        name: 'JEE Template',
        code: 'JEE-TPL',
        categoryId: cat.body.id,
        mode: 'hybrid',
        durationValue: 2,
        durationUnit: 'years',
        isTemplate: true,
        subjectIds: [ids.subject],
      });
    expect(template.status).toBe(201);
    const course = await request(app)
      .post(`/api/academics/courses/${template.body.id}/clone`)
      .set(bearer(admin))
      .send({ name: 'JEE 2031', code: 'JEE-31', branchIds: [branchId, branch2Id] });
    expect(course.status).toBe(201);
    expect(course.body.isTemplate).toBe(false);
    expect(course.body.templateId).toBe(template.body.id);
    expect(course.body.subjectIds).toEqual([ids.subject]);
    expect([...course.body.branchIds].sort()).toEqual([branchId, branch2Id].sort());
    ids.course = course.body.id;

    const syllabus = await request(app)
      .get(`/api/academics/courses/${ids.course}/syllabus`)
      .set(bearer(teacher));
    expect(syllabus.status).toBe(200);
    expect(JSON.stringify(syllabus.body)).toContain('Projectile motion');

    const dup = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: 'Dup', code: 'JEE-31' });
    expect(dup.status).toBe(409);
  });

  it('forbids teachers from managing courses', async () => {
    const res = await request(app)
      .post('/api/academics/courses')
      .set(bearer(teacher))
      .send({ name: 'Nope', code: 'NOPE' });
    expect(res.status).toBe(403);
    expect((await request(app).get('/api/academics/courses').set(bearer(teacher))).status).toBe(200);
  });

  it('creates batches, classrooms and enrolls students within capacity', async () => {
    const batch = await request(app)
      .post('/api/academics/batches')
      .set(bearer(admin))
      .send({
        branchId,
        courseId: ids.course,
        academicSessionId: ids.session1,
        name: 'JEE Morning',
        code: 'JEE-M',
        capacity: 2,
        startDate: '2030-04-01',
        teachers: [{ teacherUserId: teacherId, subjectId: ids.subject }],
      });
    expect(batch.status).toBe(201);
    ids.batch = batch.body.id;

    const notTeacher = await request(app)
      .put(`/api/academics/batches/${ids.batch}/teachers`)
      .set(bearer(admin))
      .send({ teachers: [{ teacherUserId: studentId }] });
    expect(notTeacher.status).toBe(400);

    const other = await request(app).post('/api/academics/batches').set(bearer(admin)).send({
      branchId,
      courseId: ids.course,
      academicSessionId: ids.session1,
      name: 'JEE Evening',
      code: 'JEE-E',
      capacity: 30,
      startDate: '2030-04-01',
    });
    expect(other.status).toBe(201);
    ids.batch2 = other.body.id;

    const enroll = await request(app)
      .post(`/api/academics/batches/${ids.batch}/students`)
      .set(bearer(admin))
      .send({ studentUserIds: [studentId] });
    expect(enroll.status).toBe(201);
    const roster = await request(app).get(`/api/academics/batches/${ids.batch}/students`).set(bearer(admin));
    expect(roster.body.map((e: { studentUserId: number }) => e.studentUserId)).toEqual([studentId]);
    expect(
      (await request(app).get(`/api/academics/batches/${ids.batch}/students`).set(bearer(student))).status,
    ).toBe(403);
    expect(
      (await request(app).get(`/api/academics/batches/${ids.batch}/students`).set(bearer(teacher))).status,
    ).toBe(200);
    const shrink = await request(app)
      .patch(`/api/academics/batches/${ids.batch}`)
      .set(bearer(admin))
      .send({ capacity: 0 });
    expect(shrink.status).toBe(422);

    const room = await request(app)
      .post('/api/academics/classrooms')
      .set(bearer(admin))
      .send({ branchId, name: 'Room 101', capacity: 40 });
    expect(room.status).toBe(201);
    ids.room = room.body.id;
    const tiny = await request(app)
      .post('/api/academics/classrooms')
      .set(bearer(admin))
      .send({ branchId, name: 'Cabin', capacity: 1 });
    ids.tinyRoom = tiny.body.id;
  });

  it('configures a recurring timetable, generates sessions and prevents double booking', async () => {
    const day = dow(GEN_FROM);
    const sched = await request(app).post('/api/academics/schedules').set(bearer(admin)).send({
      batchId: ids.batch,
      subjectId: ids.subject,
      teacherUserId: teacherId,
      classroomId: ids.room,
      dayOfWeek: day,
      startTime: '09:00',
      endTime: '10:30',
      effectiveFrom: '2031-01-01',
    });
    expect(sched.status).toBe(201);
    expect(sched.body.startTime).toBe('09:00');
    ids.schedule = sched.body.id;

    // Same teacher, overlapping time, other batch → teacher double booking.
    const teacherClash = await request(app).post('/api/academics/schedules').set(bearer(admin)).send({
      batchId: ids.batch2,
      teacherUserId: teacherId,
      dayOfWeek: day,
      startTime: '10:00',
      endTime: '11:00',
      effectiveFrom: '2031-02-01',
    });
    expect(teacherClash.status).toBe(409);
    expect(teacherClash.body.error.code).toBe('DOUBLE_BOOKING');

    // Same classroom, different teacher → classroom double booking.
    const roomClash = await request(app).post('/api/academics/schedules').set(bearer(admin)).send({
      batchId: ids.batch2,
      teacherUserId: subTeacherId,
      classroomId: ids.room,
      dayOfWeek: day,
      startTime: '09:30',
      endTime: '10:00',
      effectiveFrom: '2031-01-01',
    });
    expect(roomClash.status).toBe(409);

    const tooSmall = await request(app)
      .post('/api/academics/schedules')
      .set(bearer(admin))
      .send({
        batchId: ids.batch2,
        teacherUserId: teacherId,
        classroomId: ids.tinyRoom,
        dayOfWeek: (day + 1) % 7,
        startTime: '09:00',
        endTime: '10:00',
        effectiveFrom: '2031-01-01',
      });
    expect(tooSmall.status).toBe(409);
    expect(tooSmall.body.error.code).toBe('ROOM_TOO_SMALL');

    // Back-to-back slots are fine.
    const adjacent = await request(app).post('/api/academics/schedules').set(bearer(admin)).send({
      batchId: ids.batch2,
      teacherUserId: teacherId,
      dayOfWeek: day,
      startTime: '10:30',
      endTime: '11:30',
      effectiveFrom: '2031-01-01',
    });
    expect(adjacent.status).toBe(201);

    const gen = await request(app)
      .post('/api/academics/schedules/generate')
      .set(bearer(admin))
      .send({ from: GEN_FROM, to: GEN_TO, batchId: ids.batch });
    expect(gen.status).toBe(200);
    expect(gen.body.created).toBe(4);
    const again = await request(app)
      .post('/api/academics/schedules/generate')
      .set(bearer(admin))
      .send({ from: GEN_FROM, to: GEN_TO, batchId: ids.batch });
    expect(again.body).toMatchObject({ created: 0, skippedExisting: 4 });

    const sessions = await request(app)
      .get('/api/academics/class-sessions')
      .query({ from: GEN_FROM, to: GEN_TO, batchId: ids.batch })
      .set(bearer(admin));
    expect(sessions.body.total).toBe(4);
    expect(sessions.body.items[0]).toMatchObject({ date: GEN_FROM, startTime: '09:00', endTime: '10:30' });
    expect(sessions.body.items[0].teacher.id).toBe(teacherId);
    ids.cs1 = sessions.body.items[0].id;
    ids.cs2 = sessions.body.items[1].id;
    ids.cs3 = sessions.body.items[2].id;

    // Ad-hoc class for the same batch at an overlapping time → batch double booking.
    const batchClash = await request(app).post('/api/academics/class-sessions').set(bearer(admin)).send({
      batchId: ids.batch,
      teacherUserId: subTeacherId,
      date: GEN_FROM,
      startTime: '10:00',
      endTime: '11:00',
    });
    expect(batchClash.status).toBe(409);
  });

  it('reschedules, cancels and substitutes classes and notifies participants', async () => {
    consoleOutbox.length = 0;
    // Moving into the next week's slot of the same batch is a double booking.
    const clash = await request(app)
      .post(`/api/academics/class-sessions/${ids.cs1}/reschedule`)
      .set(bearer(admin))
      .send({ date: addDays(GEN_FROM, 7), startTime: '10:00', endTime: '11:00' });
    expect(clash.status).toBe(409);

    const moved = await request(app)
      .post(`/api/academics/class-sessions/${ids.cs1}/reschedule`)
      .set(bearer(admin))
      .send({ date: addDays(GEN_FROM, 1), startTime: '14:00', endTime: '15:30', reason: 'Holiday' });
    expect(moved.status).toBe(200);
    expect(moved.body.date).toBe(addDays(GEN_FROM, 1));
    expect(moved.body.rescheduledFrom).toContain(GEN_FROM);

    const cancelled = await request(app)
      .post(`/api/academics/class-sessions/${ids.cs2}/cancel`)
      .set(bearer(admin))
      .send({ reason: 'Teacher on leave' });
    expect(cancelled.body.status).toBe('cancelled');

    const sub = await request(app)
      .post(`/api/academics/class-sessions/${ids.cs3}/substitute`)
      .set(bearer(admin))
      .send({ teacherUserId: subTeacherId });
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ teacherUserId: subTeacherId, originalTeacherUserId: teacherId });

    await processDueJobs();
    const pushes = consoleOutbox.filter((m) => m.data?.type === ACADEMICS_CLASS_CHANGED_JOB);
    expect(pushes.some((m) => m.to === `user:${studentId}` && m.data?.change === 'cancelled')).toBe(true);
    expect(pushes.some((m) => m.to === `user:${teacherId}` && m.data?.change === 'substituted')).toBe(true);
    expect(pushes.some((m) => m.to === `user:${subTeacherId}` && m.data?.change === 'substituted')).toBe(
      true,
    );
    expect(pushes.some((m) => m.data?.change === 'rescheduled')).toBe(true);

    // Regeneration does not recreate the rescheduled occurrence.
    const regen = await request(app)
      .post('/api/academics/schedules/generate')
      .set(bearer(admin))
      .send({ from: GEN_FROM, to: GEN_TO, batchId: ids.batch });
    expect(regen.body.created).toBe(0);
  });

  it('lets the class teacher complete classes and post notes/homework that students can comment on', async () => {
    const yesterday = addDays(isoDate(new Date()), -1);
    const adhoc = await request(app).post('/api/academics/class-sessions').set(bearer(admin)).send({
      batchId: ids.batch,
      subjectId: ids.subject,
      teacherUserId: teacherId,
      classroomId: ids.room,
      date: yesterday,
      startTime: '16:00',
      endTime: '17:00',
    });
    expect(adhoc.status).toBe(201);
    ids.past = adhoc.body.id;

    // Substitute teacher is not the class teacher here.
    const sub = (await login(SUB_TEACHER)).accessToken;
    expect(
      (
        await request(app)
          .post(`/api/academics/class-sessions/${ids.past}/complete`)
          .set(bearer(sub))
          .send({ actualDurationMinutes: 55 })
      ).status,
    ).toBe(403);
    const done = await request(app)
      .post(`/api/academics/class-sessions/${ids.past}/complete`)
      .set(bearer(teacher))
      .send({ actualDurationMinutes: 55, completionNotes: 'Covered projectiles' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', actualDurationMinutes: 55 });
    expect(
      (
        await request(app)
          .post(`/api/academics/class-sessions/${ids.cs3}/complete`)
          .set(bearer(admin))
          .send({ actualDurationMinutes: 50 })
      ).status,
    ).toBe(400); // future class

    const upload = await request(app)
      .post('/api/files')
      .set(bearer(teacher))
      .field('module', 'academics')
      .attach('file', Buffer.from('worksheet'), { filename: 'worksheet.txt', contentType: 'text/plain' });
    expect(upload.status).toBe(201);

    const hw = await request(app)
      .post(`/api/academics/class-sessions/${ids.past}/notes`)
      .set(bearer(teacher))
      .send({
        kind: 'homework',
        title: 'Exercise 2.1',
        body: 'Solve all',
        dueDate: addDays(yesterday, 7),
        fileIds: [upload.body.id],
      });
    expect(hw.status, JSON.stringify(hw.body)).toBe(201);
    expect(hw.body.attachments).toHaveLength(1);
    expect(hw.body.attachments[0].url).toBeTruthy();
    ids.note = hw.body.id;

    expect(
      (
        await request(app)
          .post(`/api/academics/class-sessions/${ids.past}/notes`)
          .set(bearer(student))
          .send({ title: 'x' })
      ).status,
    ).toBe(403);

    const comment = await request(app)
      .post(`/api/academics/class-notes/${ids.note}/comments`)
      .set(bearer(student))
      .send({ body: 'Is Q3 mandatory?' });
    expect(comment.status).toBe(201);

    const notes = await request(app)
      .get(`/api/academics/class-sessions/${ids.past}/notes`)
      .set(bearer(student));
    expect(notes.status).toBe(200);
    expect(notes.body[0].comments[0]).toMatchObject({ body: 'Is Q3 mandatory?', user: { id: studentId } });

    const editByStudent = await request(app)
      .patch(`/api/academics/class-notes/${ids.note}`)
      .set(bearer(student))
      .send({ title: 'Hacked' });
    expect(editByStudent.status).toBe(403);
  });

  it("shows each user's own timetable", async () => {
    const mine = await request(app)
      .get('/api/academics/my-timetable')
      .query({ from: GEN_FROM, to: GEN_TO })
      .set(bearer(student));
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(4);
    const t = await request(app)
      .get('/api/academics/my-timetable')
      .query({ from: GEN_FROM, to: GEN_TO })
      .set(bearer(teacher));
    // Rescheduled + cancelled remain the teacher's; the substituted one moves to the substitute.
    expect(t.body.items.map((s: { id: number }) => s.id)).not.toContain(ids.cs3);
    const sub = (await login(SUB_TEACHER)).accessToken;
    const s = await request(app)
      .get('/api/academics/my-timetable')
      .query({ from: GEN_FROM, to: GEN_TO })
      .set(bearer(sub));
    expect(s.body.items.map((x: { id: number }) => x.id)).toContain(ids.cs3);
  });

  it('promotes students to a batch in the next session keeping history', async () => {
    const next = await request(app).post('/api/academics/batches').set(bearer(admin)).send({
      branchId,
      courseId: ids.course,
      academicSessionId: ids.session2,
      name: 'JEE Year 2',
      code: 'JEE-Y2',
      capacity: 30,
      startDate: '2031-04-01',
    });
    expect(next.status).toBe(201);
    const backwards = await request(app)
      .post('/api/academics/promotions')
      .set(bearer(admin))
      .send({ fromBatchId: next.body.id, toBatchId: ids.batch });
    expect(backwards.status).toBe(400);
    const promo = await request(app)
      .post('/api/academics/promotions')
      .set(bearer(admin))
      .send({ fromBatchId: ids.batch, toBatchId: next.body.id });
    expect(promo.status).toBe(200);
    expect(promo.body.promoted).toBe(1);
    const history = await request(app)
      .get(`/api/academics/students/${studentId}/history`)
      .set(bearer(student));
    expect(history.status).toBe(200);
    const statuses = history.body.enrollments.map(
      (h: { batchId: number; status: string }) => `${h.batchId}:${h.status}`,
    );
    expect(statuses).toEqual(expect.arrayContaining([`${ids.batch}:promoted`, `${next.body.id}:active`]));
    const promotions = await request(app).get('/api/academics/promotions').set(bearer(admin));
    expect(promotions.body.total).toBe(1);

    const members = (instituteId: number, batchId: number) =>
      runWithContext({ system: true, instituteId }, () => getBatchMemberUserIds(batchId));
    expect(await members(1, next.body.id)).toContain(studentId);
    expect(await members(1, ids.batch)).not.toContain(studentId);
    expect(await members(2, next.body.id)).toEqual([]);
  });

  it('isolates academics data between institutes', async () => {
    const z = (path: string) => request(app).get(`/api/academics${path}`).set(bearer(zenith));
    expect((await z(`/courses/${ids.course}`)).status).toBe(404);
    expect((await z(`/batches/${ids.batch}`)).status).toBe(404);
    expect((await z(`/class-sessions/${ids.cs1}`)).status).toBe(404);
    expect((await z(`/class-sessions/${ids.past}/notes`)).status).toBe(404);
    expect((await z('/courses')).body.total).toBe(0);
    expect((await z('/class-sessions').query({ from: GEN_FROM, to: GEN_TO })).body.total).toBe(0);
    expect(
      (
        await request(app)
          .post(`/api/academics/class-sessions/${ids.cs1}/cancel`)
          .set(bearer(zenith))
          .send({ reason: 'hack' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/academics/class-notes/${ids.note}`)
          .set(bearer(zenith))
          .send({ title: 'hack' })
      ).status,
    ).toBe(404);

    // Apex cannot attach a Zenith branch, and client-supplied instituteId is ignored.
    const cross = await request(app)
      .post('/api/academics/classrooms')
      .set(bearer(admin))
      .send({ branchId: zenithBranchId, name: 'X', capacity: 5 });
    expect(cross.status).toBe(404);
    const zs = await request(app)
      .post('/api/academics/subjects')
      .set(bearer(zenith))
      .send({ name: 'Chemistry', instituteId: 1 });
    expect(zs.status).toBe(201);
    expect(zs.body.instituteId).toBe(2);
    // Zenith teachers/students cannot be assigned by Apex.
    const zTeacher = await User.findOne({ where: { mobile: '9200000004' } });
    const bad = await request(app).post('/api/academics/class-sessions').set(bearer(admin)).send({
      batchId: ids.batch2,
      teacherUserId: zTeacher!.id,
      date: '2031-06-02',
      startTime: '09:00',
      endTime: '10:00',
    });
    expect(bad.status).toBe(400);
    expect(await ClassSession.count({ where: { instituteId: 2 } })).toBe(0);
  });
});
