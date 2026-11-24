import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Branch } from '../src/modules/branches/branch.model';
import { User } from '../src/modules/users/user.model';
import {
  AcademicSession,
  Batch,
  BatchStudent,
  BatchTeacher,
  Course,
  CourseSubject,
  Subject,
} from '../src/modules/academics/models';
import { LmsResource, LmsResourceBatch } from '../src/modules/lms/models';
import { NotificationMessage } from '../src/modules/notifications/models';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import {
  DEMO_PASSWORD,
  USERS,
  bearer,
  getApp,
  idWatermarks,
  login,
  purgeAcademicFixtures,
  purgeCreatedSince,
  purgeRows,
} from './helpers';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
const ZENITH_STUDENT = { mobile: '9200000005', password: DEMO_PASSWORD };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('doubts module', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let student: string;
  let zenith: string;
  let zenithStudent: string;
  let studentUserId: number;
  let teacherUserId: number;
  let marks: Record<string, number>;
  const ids: Record<string, number> = {};

  const api = (method: 'get' | 'post' | 'put', url: string, token: string) =>
    request(app)[method](`/api${url}`).set(bearer(token));

  beforeAll(async () => {
    app = await getApp();
    marks = await idWatermarks(['doubt_replies', 'doubts', 'files', 'notification_messages', 'jobs']);
    [admin, teacher, student, zenith, zenithStudent] = await Promise.all(
      [USERS.apexBranchAdmin, USERS.apexTeacher, STUDENT, USERS.zenithAdmin, ZENITH_STUDENT].map(
        async (u) => (await login(u)).accessToken,
      ),
    );
    studentUserId = (await User.findOne({ where: { mobile: STUDENT.mobile } }))!.id;
    teacherUserId = (await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } }))!.id;
    const branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    const i = 1;
    const session = await AcademicSession.create({
      instituteId: i,
      name: 'Doubts 2041',
      startDate: '2041-04-01',
      endDate: '2042-03-31',
    });
    const physics = await Subject.create({ instituteId: i, name: 'Doubt Physics', code: 'DBT-PHY' });
    const maths = await Subject.create({ instituteId: i, name: 'Doubt Maths', code: 'DBT-MAT' });
    const course = await Course.create({
      instituteId: i,
      name: 'Doubt JEE',
      code: 'DBT-JEE',
      categoryId: null,
      templateId: null,
      description: null,
      durationValue: null,
      durationUnit: null,
    });
    await CourseSubject.create({ instituteId: i, courseId: course.id, subjectId: physics.id });
    await CourseSubject.create({ instituteId: i, courseId: course.id, subjectId: maths.id });
    const batch = await Batch.create({
      instituteId: i,
      branchId,
      courseId: course.id,
      academicSessionId: session.id,
      name: 'Doubt Batch',
      code: 'DBT-A',
      capacity: 30,
      startDate: '2041-04-01',
      endDate: null,
    });
    await BatchStudent.create({
      instituteId: i,
      batchId: batch.id,
      studentUserId,
      joinedOn: new Date().toISOString().slice(0, 10),
      leftOn: null,
      promotedFromId: null,
    });
    await BatchTeacher.create({ instituteId: i, batchId: batch.id, subjectId: physics.id, teacherUserId });
    const lecture = await LmsResource.create({
      instituteId: i,
      branchId,
      courseId: course.id,
      subjectId: physics.id,
      chapterId: null,
      topicId: null,
      title: 'Doubt lecture: lenses',
      description: null,
      type: 'video',
      status: 'published',
      fileId: null,
      externalUrl: 'https://example.com/lenses.mp4',
      durationSeconds: 600,
      accessDays: null,
      availableFrom: null,
      availableUntil: null,
      createdByUserId: null,
    });
    await LmsResourceBatch.create({ instituteId: i, resourceId: lecture.id, batchId: batch.id });
    Object.assign(ids, {
      session: session.id,
      physics: physics.id,
      maths: maths.id,
      course: course.id,
      batch: batch.id,
      lecture: lecture.id,
    });
  });

  afterAll(async () => {
    await purgeCreatedSince(marks);
    await purgeRows('lms_resources', [ids.lecture]);
    await purgeAcademicFixtures({
      batchIds: [ids.batch],
      courseIds: [ids.course],
      sessionIds: [ids.session],
    });
    await purgeRows('subjects', [ids.physics, ids.maths]);
    await getSequelize().query("UPDATE users SET locale = 'en' WHERE id = ?", {
      replacements: [studentUserId],
    });
  });

  it('offers the student their batches and subjects', async () => {
    const res = await api('get', '/doubts/options', student).expect(200);
    const batch = res.body.batches.find((b: { id: number }) => b.id === ids.batch);
    expect(batch.subjects.map((s: { name: string }) => s.name)).toEqual(['Doubt Maths', 'Doubt Physics']);
  });

  it('asks about a lecture with a photo and routes it to the subject teacher', async () => {
    const res = await api('post', '/doubts', student)
      .field('question', 'Why is the image inverted for a convex lens?')
      .field('lectureId', String(ids.lecture))
      .field('positionSeconds', '125')
      .attach('file', PNG, { filename: 'board.png', contentType: 'image/png' })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'open',
      isMine: true,
      canAnswer: false,
      hasPhoto: true,
      teacher: { id: teacherUserId },
      batch: { id: ids.batch },
      subject: { id: ids.physics, name: 'Doubt Physics' },
      lecture: { id: ids.lecture, positionSeconds: 125 },
    });
    expect(res.body.photoUrl).toBeTruthy();
    ids.doubt = res.body.id;
    expect(
      await NotificationMessage.count({
        where: { instituteId: 1, eventKey: 'doubts.asked', userId: teacherUserId },
      }),
    ).toBeGreaterThan(0);
  });

  it('rejects non-photo attachments and short questions', async () => {
    await api('post', '/doubts', student)
      .field('question', 'What is this file?')
      .attach('file', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' })
      .expect(400);
    await api('post', '/doubts', student).send({ question: 'a' }).expect(422);
  });

  it('shows the doubt in the teacher inbox and lets the teacher answer it', async () => {
    const counts = await api('get', '/doubts/counts', teacher).expect(200);
    expect(counts.body.waiting).toBeGreaterThan(0);
    const inbox = await api('get', '/doubts?box=inbox&status=open', teacher).expect(200);
    expect(inbox.body.items.map((d: { id: number }) => d.id)).toContain(ids.doubt);

    const res = await api('post', `/doubts/${ids.doubt}/replies`, teacher)
      .field('body', 'Rays cross after the lens, so the image flips.')
      .attach('file', PNG, { filename: 'diagram.png', contentType: 'image/png' })
      .expect(201);
    expect(res.body.status).toBe('answered');
    expect(res.body.replies[0]).toMatchObject({ fromTeacher: true, author: { id: teacherUserId } });
    expect(res.body.replies[0].photoUrl).toBeTruthy();
    expect(
      await NotificationMessage.count({
        where: { instituteId: 1, eventKey: 'doubts.answered', userId: studentUserId, channel: 'in_app' },
      }),
    ).toBe(1);
    expect((await api('get', '/doubts/counts', student).expect(200)).body.answered).toBe(1);
  });

  it('reopens on a student follow-up and closes when the student marks it solved', async () => {
    const follow = await api('post', `/doubts/${ids.doubt}/replies`, student)
      .send({ body: 'And for a concave lens?' })
      .expect(201);
    expect(follow.body.status).toBe('open');
    const solved = await api('post', `/doubts/${ids.doubt}/resolve`, student).expect(200);
    expect(solved.body.status).toBe('resolved');
    await api('post', `/doubts/${ids.doubt}/replies`, teacher).send({ body: 'late' }).expect(409);
  });

  it('lists the student’s own doubts and lets branch staff see every doubt', async () => {
    const mine = await api('get', '/doubts?box=mine', student).expect(200);
    expect(mine.body.items[0]).toMatchObject({ id: ids.doubt, status: 'resolved', replyCount: 2 });
    await api('get', '/doubts?box=inbox', student).expect(403);
    const all = await api('get', '/doubts?box=all', admin).expect(200);
    expect(all.body.items.map((d: { id: number }) => d.id)).toContain(ids.doubt);
    await api('get', '/doubts?box=all', teacher).expect(403);
  });

  it('keeps doubts inside the institute and out of other students’ reach', async () => {
    await api('get', `/doubts/${ids.doubt}`, zenith).expect(404);
    await api('get', `/doubts/${ids.doubt}`, zenithStudent).expect(404);
    await api('post', '/doubts', student)
      .send({ question: 'About a batch I am not in', batchId: 999999 })
      .expect(404);
  });

  it('defaults to English, then saves the user’s language and returns it from /me', async () => {
    expect((await api('get', '/auth/me', student).expect(200)).body.user.locale).toBe('en');
    await api('put', '/auth/me/locale', student).send({ locale: 'fr' }).expect(422);
    await api('put', '/auth/me/locale', student).send({ locale: 'hi' }).expect(200, { locale: 'hi' });
    expect((await api('get', '/auth/me', student).expect(200)).body.user.locale).toBe('hi');
  });
});
