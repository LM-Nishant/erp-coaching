import fsp from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Branch } from '../src/modules/branches/branch.model';
import { User } from '../src/modules/users/user.model';
import {
  AcademicSession,
  Batch,
  BatchStudent,
  Chapter,
  Course,
  CourseSubject,
  Subject,
  Topic,
} from '../src/modules/academics/models';
import { NotificationMessage } from '../src/modules/notifications/models';
import { Device } from '../src/modules/authentication/models';
import { LmsResource } from '../src/modules/lms/models';
import { setCourseEntitlementProvider } from '../src/modules/lms/api';
import { setVideoTranscoder, FfmpegTranscoder } from '../src/modules/lms/transcoder';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { config } from '../src/infrastructure/config';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { DEMO_PASSWORD, USERS, bearer, getApp, login, newDevice, stableDevice } from './helpers';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
const PARENT = { mobile: '9100000006', password: DEMO_PASSWORD };
const ZENITH_STUDENT = { mobile: '9200000005', password: DEMO_PASSWORD };

describe('lms module', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let student: string;
  let studentAndroid: string;
  let androidLogin: Awaited<ReturnType<typeof login>>;
  let parent: string;
  let zenith: string;
  let zenithStudent: string;
  let studentUserId: number;
  let branchId: number;
  const ids: Record<string, number> = {};

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, token: string) =>
    request(app)[method](`/api${url}`).set(bearer(token));

  beforeAll(async () => {
    app = await getApp();
    [admin, teacher, student, parent, zenith, zenithStudent] = await Promise.all(
      [USERS.apexAdmin, USERS.apexTeacher, STUDENT, PARENT, USERS.zenithAdmin, ZENITH_STUDENT].map(
        async (u) => (await login(u)).accessToken,
      ),
    );
    androidLogin = await login(STUDENT, newDevice('android') as unknown as ReturnType<typeof stableDevice>);
    studentAndroid = androidLogin.accessToken;
    studentUserId = (await User.findOne({ where: { mobile: STUDENT.mobile } }))!.id;
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;

    const i = 1;
    const session = await AcademicSession.create({
      instituteId: i,
      name: 'LMS 2040',
      startDate: '2040-04-01',
      endDate: '2041-03-31',
    });
    const subject = await Subject.create({ instituteId: i, name: 'LMS Physics', code: 'LMS-PHY' });
    const chapter = await Chapter.create({ instituteId: i, subjectId: subject.id, name: 'Optics' });
    const topic = await Topic.create({
      instituteId: i,
      chapterId: chapter.id,
      name: 'Lenses',
      durationMinutes: null,
    });
    const course = await Course.create({
      instituteId: i,
      name: 'LMS NEET',
      code: 'LMS-NEET',
      categoryId: null,
      templateId: null,
      description: null,
      durationValue: null,
      durationUnit: null,
    });
    const other = await Course.create({
      instituteId: i,
      name: 'LMS Foundation',
      code: 'LMS-FND',
      categoryId: null,
      templateId: null,
      description: null,
      durationValue: null,
      durationUnit: null,
    });
    await CourseSubject.create({ instituteId: i, courseId: course.id, subjectId: subject.id });
    const batch = await Batch.create({
      instituteId: i,
      branchId,
      courseId: course.id,
      academicSessionId: session.id,
      name: 'LMS Batch A',
      code: 'LMS-A',
      capacity: 30,
      startDate: '2040-04-01',
      endDate: null,
    });
    const batchB = await Batch.create({
      instituteId: i,
      branchId,
      courseId: course.id,
      academicSessionId: session.id,
      name: 'LMS Batch B',
      code: 'LMS-B',
      capacity: 30,
      startDate: '2040-04-01',
      endDate: null,
    });
    await BatchStudent.create({
      instituteId: i,
      batchId: batch.id,
      studentUserId,
      joinedOn: new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10),
      leftOn: null,
      promotedFromId: null,
    });
    Object.assign(ids, {
      subject: subject.id,
      chapter: chapter.id,
      topic: topic.id,
      course: course.id,
      other: other.id,
      batch: batch.id,
      batchB: batchB.id,
      session: session.id,
    });
  });

  afterAll(async () => {
    setCourseEntitlementProvider(null);
    setVideoTranscoder(new FfmpegTranscoder());
    // HLS segments are *.ts files; leaving them in tmp/ would trip ESLint.
    await fsp.rm(path.join(config.storageLocalRoot, 'institutes', '1', 'lms'), {
      recursive: true,
      force: true,
    });
    // Test files share one database: remove the academics rows created above so suites that expect an
    // institute without academic sessions/courses (academics, integration) are unaffected by run order.
    const db = getSequelize();
    const del = (sql: string, replacements: unknown[]) => db.query(sql, { replacements });
    for (const t of [
      'lms_submission_files',
      'lms_submissions',
      'lms_assignment_files',
      'lms_assignments',
      'lms_offline_licenses',
      'lms_progress',
      'lms_access_grants',
      'lms_resource_batches',
      'lms_resources',
    ])
      await del(`DELETE FROM ${t} WHERE institute_id = ?`, [1]);
    const batches = [ids.batch, ids.batchB];
    await del('DELETE FROM batch_students WHERE batch_id IN (?)', [batches]);
    await del('DELETE FROM batches WHERE id IN (?)', [batches]);
    await del('DELETE FROM course_subjects WHERE course_id IN (?)', [[ids.course, ids.other]]);
    await del('DELETE FROM courses WHERE id IN (?)', [[ids.course, ids.other]]);
    await del('DELETE FROM topics WHERE id = ?', [ids.topic]);
    await del('DELETE FROM chapters WHERE id = ?', [ids.chapter]);
    await del('DELETE FROM subjects WHERE id = ?', [ids.subject]);
    await del('DELETE FROM academic_sessions WHERE id = ?', [ids.session]);
  });

  /** Chunked upload of an in-memory buffer; returns the stored file id. */
  async function chunkedUpload(token: string, data: Buffer, fileName: string, mimeType: string) {
    const start = await api('post', '/lms/uploads', token).send({
      fileName,
      mimeType,
      totalBytes: data.length,
    });
    expect(start.status).toBe(201);
    const uploadId = start.body.uploadId as string;
    const half = Math.ceil(data.length / 2);
    const put = (offset: number, chunk: Buffer) =>
      api('put', `/lms/uploads/${uploadId}/chunk?offset=${offset}`, token)
        .set('Content-Type', 'application/octet-stream')
        .send(chunk);
    expect((await put(0, data.subarray(0, half))).body.receivedBytes).toBe(half);
    const done = await api('post', `/lms/uploads/${uploadId}/complete`, token);
    expect(done.status).toBe(409); // incomplete
    const mismatch = await put(0, data.subarray(half));
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error?.details?.receivedBytes ?? mismatch.body.details?.receivedBytes).toBe(half);
    const status = await api('get', `/lms/uploads/${uploadId}`, token);
    expect((await put(status.body.receivedBytes, data.subarray(half))).body.receivedBytes).toBe(data.length);
    const completed = await api('post', `/lms/uploads/${uploadId}/complete`, token);
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('completed');
    return completed.body.file.id as number;
  }

  it('uploads a lecture in resumable chunks and publishes it', async () => {
    const video = Buffer.alloc(64 * 1024, 7);
    ids.videoFile = await chunkedUpload(teacher, video, 'optics.mp4', 'video/mp4');

    const blocked = await api('post', '/lms/uploads', teacher).send({
      fileName: 'x.html',
      mimeType: 'text/html',
      totalBytes: 10,
    });
    expect(blocked.status).toBe(400);

    const created = await api('post', '/lms/resources', teacher).send({
      courseId: ids.course,
      topicId: ids.topic,
      title: 'Lens formula',
      type: 'video',
      fileId: ids.videoFile,
      durationSeconds: 600,
      access: 'paid',
      offlineAllowed: true,
      offlineExpiryHours: 48,
    });
    expect(created.status).toBe(201);
    // the chain is completed from the topic
    expect(created.body).toMatchObject({ chapterId: ids.chapter, subjectId: ids.subject, status: 'draft' });
    ids.video = created.body.id;

    const badTax = await api('post', '/lms/resources', teacher).send({
      courseId: ids.course,
      subjectId: ids.subject,
      chapterId: 999999,
      title: 'X',
      type: 'notes',
    });
    expect(badTax.status).toBe(400);

    // the student cannot see drafts yet
    expect((await api('post', `/lms/resources/${ids.video}/play`, student)).status).toBe(404);
    expect((await api('post', `/lms/resources/${ids.video}/publish`, teacher)).body.status).toBe('published');

    const list = await api('get', `/lms/resources?courseId=${ids.course}`, teacher);
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: { id: number }) => r.id)).toContain(ids.video);

    const patched = await api('patch', `/lms/resources/${ids.video}`, teacher).send({ sortOrder: 2 });
    expect(patched.body.sortOrder).toBe(2);
  });

  it('forbids learners from managing content and isolates tenants', async () => {
    const res = await api('post', '/lms/resources', student).send({
      courseId: ids.course,
      title: 'x',
      type: 'notes',
    });
    expect(res.status).toBe(403);
    expect((await api('get', '/lms/resources', student)).status).toBe(403);
    expect(
      (
        await api('post', '/lms/uploads', parent).send({
          fileName: 'a',
          mimeType: 'video/mp4',
          totalBytes: 5,
        })
      ).status,
    ).toBe(403);

    expect((await api('get', `/lms/resources/${ids.video}`, zenith)).status).toBe(404);
    expect((await api('patch', `/lms/resources/${ids.video}`, zenith).send({ title: 'pwn' })).status).toBe(
      404,
    );
    expect((await api('post', `/lms/resources/${ids.video}/play`, zenithStudent)).status).toBe(404);
    const zl = await api('get', '/lms/library', zenithStudent);
    expect(zl.body.find((c: { id: number }) => c.id === ids.course)).toBeUndefined();

    // instituteId in the body is ignored; the Apex course does not exist for Zenith
    const cross = await api('post', '/lms/resources', zenith).send({
      instituteId: 1,
      courseId: ids.course,
      title: 'x',
      type: 'notes',
    });
    expect(cross.status).toBe(400);
  });

  it('plays an enrolled course as progressive MP4 with range support and a watermark', async () => {
    const play = await api('post', `/lms/resources/${ids.video}/play`, student);
    expect(play.status).toBe(200);
    expect(play.body.kind).toBe('mp4');
    expect(play.body.watermark.text).toContain(STUDENT.mobile);
    const url = new URL(play.body.url);
    const ranged = await request(app).get(url.pathname).set('Range', 'bytes=0-99');
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe('bytes 0-99/65536');

    // notes are never downloadable unless flagged; videos never via /download
    expect((await api('post', `/lms/resources/${ids.video}/download`, student)).status).toBe(403);
  });

  it('enforces free vs paid access, batch restrictions, time limits and manual grants', async () => {
    const mk = async (body: Record<string, unknown>) => {
      const r = await api('post', '/lms/resources', teacher).send({
        type: 'link',
        externalUrl: 'https://example.com/x',
        ...body,
      });
      expect(r.status).toBe(201);
      await api('post', `/lms/resources/${r.body.id}/publish`, teacher);
      return r.body.id as number;
    };
    ids.freeOther = await mk({ courseId: ids.other, title: 'Free taster', access: 'free' });
    ids.paidOther = await mk({ courseId: ids.other, title: 'Paid chapter', access: 'paid' });
    ids.onlyB = await mk({
      courseId: ids.course,
      title: 'Batch B only',
      access: 'paid',
      batchIds: [ids.batchB],
    });
    ids.expired = await mk({ courseId: ids.course, title: 'Short access', access: 'paid', accessDays: 5 });
    ids.longer = await mk({ courseId: ids.course, title: 'Long access', access: 'paid', accessDays: 30 });

    const lib = await api('get', '/lms/library', student);
    const byId = (id: number) => lib.body.find((c: { id: number }) => c.id === id);
    expect(byId(ids.course)).toMatchObject({ entitled: true });
    expect(byId(ids.other)).toMatchObject({ entitled: false, resourceCount: 2 });

    const other = await api('get', `/lms/courses/${ids.other}/contents`, student);
    const lock = (id: number) => other.body.resources.find((r: { id: number }) => r.id === id);
    expect(lock(ids.freeOther)).toMatchObject({ locked: false });
    expect(lock(ids.paidOther)).toMatchObject({
      locked: true,
      lockReason: 'not-entitled',
      externalUrl: null,
    });
    expect((await api('post', `/lms/resources/${ids.paidOther}/play`, student)).status).toBe(403);
    expect((await api('post', `/lms/resources/${ids.freeOther}/play`, student)).body.kind).toBe('link');

    const own = await api('get', `/lms/courses/${ids.course}/contents`, student);
    const flat = JSON.stringify(own.body);
    expect(flat).not.toContain('Batch B only'); // batch-restricted to a batch the student is not in
    expect(own.body.subjects[0].chapters[0].topics[0].resources[0].id).toBe(ids.video);
    const top = (id: number) => own.body.resources.find((r: { id: number }) => r.id === id);
    expect(top(ids.expired)).toMatchObject({ locked: true, lockReason: 'expired' }); // joined 10 days ago
    expect(top(ids.longer).locked).toBe(false);
    expect((await api('post', `/lms/resources/${ids.onlyB}/play`, student)).status).toBe(404);

    // a manual grant opens the other course; revoking closes it again
    const grant = await api('post', '/lms/grants', admin).send({
      studentUserId,
      courseId: ids.other,
      note: 'trial',
    });
    expect(grant.status).toBe(201);
    expect(
      (await api('post', '/lms/grants', teacher).send({ studentUserId, courseId: ids.other })).status,
    ).toBe(403);
    expect((await api('post', `/lms/resources/${ids.paidOther}/play`, student)).status).toBe(200);
    expect((await api('delete', `/lms/grants/${grant.body.id}`, admin)).status).toBe(204);
    expect((await api('post', `/lms/resources/${ids.paidOther}/play`, student)).status).toBe(403);

    // fees (or any module) can plug in its own entitlement rules
    setCourseEntitlementProvider({
      hasCourseEntitlement: async (q, batchDefault) =>
        q.courseId === ids.course
          ? { entitled: false, since: null, until: null, source: 'fees' }
          : batchDefault(q),
    });
    try {
      const play = await api('post', `/lms/resources/${ids.video}/play`, student);
      expect(play.status).toBe(403);
      expect(play.body.error?.code ?? play.body.code).toBe('LMS_NOT_ENTITLED');
    } finally {
      setCourseEntitlementProvider(null);
    }
  });

  it('tracks progress, resume position and completion', async () => {
    const p1 = await api('put', `/lms/resources/${ids.video}/progress`, student).send({
      positionSeconds: 300,
      watchedDeltaSeconds: 1000, // capped
    });
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ positionSeconds: 300, watchedSeconds: 120, completed: false });
    const cont = await api('get', '/lms/continue', student);
    expect(cont.status).toBe(200);
    expect(cont.body.find((r: { id: number }) => r.id === ids.video)).toMatchObject({
      locked: false,
      progress: { positionSeconds: 300 },
    });
    const play = await api('post', `/lms/resources/${ids.video}/play`, student);
    expect(play.body.resumeAtSeconds).toBe(300);

    for (let k = 0; k < 4; k++)
      await api('put', `/lms/resources/${ids.video}/progress`, student).send({
        positionSeconds: 540 + k,
        watchedDeltaSeconds: 120,
      });
    const done = await api('get', `/lms/resources/${ids.video}`, student);
    expect(done.body.progress).toMatchObject({ completed: true, percent: 100 });
    const after = await api('get', '/lms/continue', student);
    expect(after.body.map((r: { id: number }) => r.id)).not.toContain(ids.video);

    const link = await api('put', `/lms/resources/${ids.longer}/progress`, student).send({
      positionSeconds: 0,
      completed: true,
    });
    expect(link.body.completed).toBe(true);

    expect(
      (await api('put', `/lms/resources/${ids.video}/progress`, teacher).send({ positionSeconds: 1 })).status,
    ).toBe(403);
    const analytics = await api('get', `/lms/resources/${ids.video}/analytics`, teacher);
    expect(
      analytics.body.find((r: { student: { id: number } }) => r.student.id === studentUserId),
    ).toMatchObject({
      completed: true,
    });
    const lib = await api('get', '/lms/library', student);
    expect(lib.body.find((c: { id: number }) => c.id === ids.course).completedCount).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('issues encrypted offline licences only to the mobile app', async () => {
    const web = await api('post', `/lms/resources/${ids.video}/offline-license`, student);
    expect(web.status).toBe(403);
    expect(web.body.error?.code ?? web.body.code).toBe('LMS_OFFLINE_APP_ONLY');

    const lic = await api('post', `/lms/resources/${ids.video}/offline-license`, studentAndroid);
    expect(lic.status).toBe(201);
    expect(Buffer.from(lic.body.contentKey, 'base64')).toHaveLength(32);
    const hours = (new Date(lic.body.expiresAt).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThanOrEqual(48);

    expect((await api('post', `/lms/resources/${ids.longer}/offline-license`, studentAndroid)).status).toBe(
      403,
    );

    const synced = await api('get', '/lms/offline-licenses', studentAndroid);
    expect(synced.body[0]).toMatchObject({
      resourceId: ids.video,
      revokedAt: null,
      contentKey: lic.body.contentKey,
    });

    // losing access revokes the copy on next sync
    await api('post', `/lms/resources/${ids.video}/unpublish`, teacher);
    const after = await api('get', '/lms/offline-licenses', studentAndroid);
    expect(after.body[0].revokedAt).not.toBeNull();
    expect(after.body[0].contentKey).toBeNull();
    await api('post', `/lms/resources/${ids.video}/publish`, teacher);
  });

  it('transcodes to HLS through the transcoder adapter and streams via signed tokens', async () => {
    setVideoTranscoder({
      available: async () => true,
      toHls: async (_input, outDir) => {
        await fsp.mkdir(outDir, { recursive: true });
        await fsp.writeFile(
          path.join(outDir, 'index.m3u8'),
          '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg_00000.ts\n#EXT-X-ENDLIST\n',
        );
        await fsp.writeFile(path.join(outDir, 'seg_00000.ts'), Buffer.alloc(188, 0x47));
        return ['index.m3u8', 'seg_00000.ts'];
      },
    });
    expect((await api('post', `/lms/resources/${ids.video}/transcode`, teacher)).body.transcodeStatus).toBe(
      'pending',
    );
    await processDueJobs();
    expect((await LmsResource.findOne({ where: { instituteId: 1, id: ids.video } }))!.transcodeStatus).toBe(
      'ready',
    );

    const play = await api('post', `/lms/resources/${ids.video}/play`, student);
    expect(play.body.kind).toBe('hls');
    const playlist = await request(app).get(new URL(play.body.url).pathname);
    expect(playlist.status).toBe(200);
    expect(playlist.text).toContain('seg_00000.ts');
    const seg = await request(app).get(new URL(play.body.url).pathname.replace('index.m3u8', 'seg_00000.ts'));
    expect(seg.status).toBe(200);
    expect(
      (await request(app).get(new URL(play.body.url).pathname.replace('index.m3u8', '..%2Fx'))).status,
    ).toBe(404);
    expect((await request(app).get('/api/lms/public/hls/forged.token/index.m3u8')).status).toBe(404);

    const mp4 = await api('post', `/lms/resources/${ids.video}/play`, student).send({ prefer: 'mp4' });
    expect(mp4.body.kind).toBe('mp4');

    // without ffmpeg, videos stay on progressive MP4
    setVideoTranscoder({ available: async () => false, toHls: async () => [] });
    await api('post', `/lms/resources/${ids.video}/transcode`, teacher);
    await processDueJobs();
    expect((await LmsResource.findOne({ where: { instituteId: 1, id: ids.video } }))!.transcodeStatus).toBe(
      'unavailable',
    );
  });

  it('runs homework: publish → notify, submit with files, late rule, grading', async () => {
    const attach = await api('post', '/lms/files', teacher).attach('file', Buffer.from('worksheet'), {
      filename: 'sheet.pdf',
      contentType: 'application/pdf',
    });
    expect(attach.status).toBe(201);

    const due = new Date(Date.now() + 2 * 86400_000).toISOString();
    const created = await api('post', '/lms/assignments', teacher).send({
      batchId: ids.batch,
      subjectId: ids.subject,
      title: 'Ray optics worksheet',
      dueAt: due,
      maxMarks: 20,
      fileIds: [attach.body.id],
    });
    expect(created.status).toBe(201);
    ids.hw = created.body.id;
    expect(
      (await api('post', '/lms/assignments', student).send({ batchId: ids.batch, title: 'x', dueAt: due }))
        .status,
    ).toBe(403);
    expect((await api('get', `/lms/assignments/${ids.hw}`, zenith)).status).toBe(404);
    expect((await api('get', `/lms/assignments/${ids.hw}`, student)).status).toBe(404); // draft

    const before = await NotificationMessage.count({
      where: { instituteId: 1, eventKey: 'homework.assigned', userId: studentUserId },
    });
    const pub = await api('post', `/lms/assignments/${ids.hw}/publish`, teacher);
    expect(pub.status).toBe(200);
    expect(pub.body.counts).toMatchObject({ students: 1, submitted: 0 });
    expect(
      await NotificationMessage.count({
        where: { instituteId: 1, eventKey: 'homework.assigned', userId: studentUserId },
      }),
    ).toBeGreaterThan(before);

    const mine = await api('get', '/lms/assignments?status=pending', student);
    expect(mine.body.items.map((a: { id: number }) => a.id)).toContain(ids.hw);
    expect(mine.body.items[0].files[0].url).toBeTruthy();

    // students cannot attach someone else's file
    expect(
      (await api('put', `/lms/assignments/${ids.hw}/submission`, student).send({ fileIds: [attach.body.id] }))
        .status,
    ).toBe(400);
    const answer = await api('post', '/lms/files', student).attach('file', Buffer.from('my answer'), {
      filename: 'answer.pdf',
      contentType: 'application/pdf',
    });
    expect(answer.status).toBe(201);
    const sub = await api('put', `/lms/assignments/${ids.hw}/submission`, student).send({
      text: 'Done',
      fileIds: [answer.body.id],
    });
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ status: 'submitted', isLate: false });

    const subs = await api('get', `/lms/assignments/${ids.hw}/submissions`, teacher);
    expect(subs.body).toHaveLength(1);
    expect((await api('get', `/lms/assignments/${ids.hw}/submissions`, student)).status).toBe(403);
    expect(
      (await api('post', `/lms/submissions/${sub.body.id}/grade`, teacher).send({ marks: 25 })).status,
    ).toBe(400);
    const graded = await api('post', `/lms/submissions/${sub.body.id}/grade`, teacher).send({
      marks: 18,
      feedback: 'Good',
    });
    expect(graded.body).toMatchObject({ status: 'graded', marks: 18, feedback: 'Good' });
    expect(
      await NotificationMessage.count({
        where: { instituteId: 1, eventKey: 'homework.graded', userId: studentUserId },
      }),
    ).toBeGreaterThan(0);
    expect(
      (await api('put', `/lms/assignments/${ids.hw}/submission`, student).send({ text: 'again' })).status,
    ).toBe(409);
    expect(
      (await api('post', `/lms/submissions/${sub.body.id}/grade`, zenith).send({ marks: 1 })).status,
    ).toBe(404);

    // past-due homework rejects submissions unless late work is allowed
    const late = await api('post', '/lms/assignments', teacher).send({
      batchId: ids.batch,
      title: 'Late rule',
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await api('post', `/lms/assignments/${late.body.id}/publish`, teacher);
    await api('patch', `/lms/assignments/${late.body.id}`, teacher).send({
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const rejected = await api('put', `/lms/assignments/${late.body.id}/submission`, student).send({
      text: 'sorry',
    });
    expect(rejected.status).toBe(409);
    await api('patch', `/lms/assignments/${late.body.id}`, teacher).send({ allowLate: true });
    const lateOk = await api('put', `/lms/assignments/${late.body.id}/submission`, student).send({
      text: 'sorry',
    });
    expect(lateOk.body.isLate).toBe(true);
  });

  it('sends due reminders only to students who have not submitted', async () => {
    const created = await api('post', '/lms/assignments', teacher).send({
      batchId: ids.batch,
      title: 'Reminder me',
      dueAt: new Date(Date.now() + 3600_000).toISOString(), // inside the 24h window → reminder runs now
    });
    await api('post', `/lms/assignments/${created.body.id}/publish`, teacher);
    await processDueJobs();
    const reminders = await NotificationMessage.findAll({
      where: { instituteId: 1, eventKey: 'homework.due', userId: studentUserId },
    });
    expect(reminders.some((m) => JSON.stringify(m.data).includes('Reminder me'))).toBe(true);
  });

  it('shows parents their children’s homework and course progress', async () => {
    const kids = await api('get', '/lms/children', parent);
    expect(kids.status).toBe(200);
    const hw = await api('get', '/lms/assignments/children', parent);
    expect(hw.status).toBe(200);
    if (kids.body.length) {
      expect(kids.body[0].courses.some((c: { id: number }) => c.id === ids.course)).toBe(true);
      expect(hw.body.some((a: { id: number }) => a.id === ids.hw)).toBe(true);
      expect((await api('get', `/lms/assignments/${ids.hw}`, parent)).status).toBe(200);
    }
    expect(
      (await api('put', `/lms/assignments/${ids.hw}/submission`, parent).send({ text: 'x' })).status,
    ).toBe(403);
  });

  // Last: it signs the android device out and revokes it.
  it('binds offline download links to the device: sign-out and revocation stop them', async () => {
    const downloadPath = async (token: string) => {
      const lic = await api('post', `/lms/resources/${ids.video}/offline-license`, token);
      expect(lic.status).toBe(201);
      const ttl = (new Date(lic.body.downloadUrlExpiresAt).getTime() - Date.now()) / 1000;
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
      return new URL(lic.body.downloadUrl).pathname;
    };
    const first = await downloadPath(studentAndroid);
    const ok = await request(app).get(first);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-length']).toBe(String(64 * 1024));

    await request(app).post('/api/auth/logout').send({ refreshToken: androidLogin.refreshToken }).expect(204);
    expect((await request(app).get(first)).status).toBe(404);

    const again = await login(STUDENT, androidLogin.device);
    const second = await downloadPath(again.accessToken);
    expect((await request(app).get(second)).status).toBe(200);

    const device = await Device.findOne({ where: { deviceUid: androidLogin.device.uid } });
    expect((await api('delete', `/auth/devices/${device!.id}`, student)).status).toBe(204);
    expect((await request(app).get(second)).status).toBe(404);
  });
});
