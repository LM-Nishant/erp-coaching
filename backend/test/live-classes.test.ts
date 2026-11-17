import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_CLIENT_EVENTS as C,
  LIVE_SERVER_EVENTS as S,
  LIVE_SOCKET_NAMESPACE,
  LIVE_SOCKET_PATH,
} from '@erp/shared';
import { Branch } from '../src/modules/branches/branch.model';
import { User } from '../src/modules/users/user.model';
import {
  AcademicSession,
  Batch,
  BatchStudent,
  BatchTeacher,
  ClassSession,
  Course,
} from '../src/modules/academics/models';
import { runWithContext } from '../src/shared/context';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import {
  onLiveRecordingReady,
  onLiveSessionEnded,
  type LiveRecordingReadyEvent,
  type LiveSessionEndedEvent,
} from '../src/modules/live-classes/api';
import { LiveParticipant } from '../src/modules/live-classes/models';
import { attachLiveSockets, closeLiveSockets } from '../src/modules/live-classes/realtime';
import { DevWebRtcStreamingProvider } from '../src/infrastructure/streaming/dev-webrtc.provider';
import { DEMO_PASSWORD, USERS, bearer, getApp, login, purgeAcademicFixtures } from './helpers';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
const PARENT = { mobile: '9100000006', password: DEMO_PASSWORD };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed socket acks
type Ack = { ok: boolean; data?: any; error?: { code: string; message: string } };

describe('live-classes module', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let student: string;
  let parent: string;
  let zenith: string;
  let branchId: number;
  let teacherId: number;
  let studentId: number;
  let batchId: number;
  let otherBatchId: number;
  let classSessionId: number;
  let liveId: number;
  let otherLiveId: number;
  let recordingId: number;

  let server: http.Server;
  let baseUrl: string;
  const sockets: Socket[] = [];
  const recordingEvents: LiveRecordingReadyEvent[] = [];
  const endedEvents: LiveSessionEndedEvent[] = [];

  const sock = (token: string) => {
    const s = connect(`${baseUrl}${LIVE_SOCKET_NAMESPACE}`, {
      path: LIVE_SOCKET_PATH,
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(s);
    return s;
  };
  const connected = (s: Socket) =>
    new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
  const emit = (s: Socket, event: string, payload: unknown = {}) =>
    new Promise<Ack>((resolve) => s.emit(event, payload, (r: Ack) => resolve(r)));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const next = <T = any>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));

  const academicFixture: { sessionIds?: number[]; courseIds?: number[] } = {};

  beforeAll(async () => {
    app = await getApp();
    [admin, teacher, student, parent, zenith] = (
      await Promise.all([
        login(USERS.apexAdmin),
        login(USERS.apexTeacher),
        login(STUDENT),
        login(PARENT),
        login(USERS.zenithAdmin),
      ])
    ).map((l) => l.accessToken);
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    teacherId = (await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } }))!.id;
    studentId = (await User.findOne({ where: { mobile: STUDENT.mobile } }))!.id;

    await runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, async () => {
      const instituteId = 1;
      const ses = await AcademicSession.create({
        instituteId,
        name: 'Live 2040',
        startDate: '2040-01-01',
        endDate: '2040-12-31',
      });
      const course = await Course.create({
        instituteId,
        categoryId: null,
        templateId: null,
        name: 'Live Course',
        code: 'LIVE-C1',
        description: null,
        durationValue: null,
        durationUnit: null,
      });
      const mk = (code: string) =>
        Batch.create({
          instituteId,
          branchId,
          courseId: course.id,
          academicSessionId: ses.id,
          name: `Live batch ${code}`,
          code,
          capacity: 30,
          startDate: '2040-01-01',
          endDate: null,
        });
      const [b1, b2] = [await mk('LIVE-B1'), await mk('LIVE-B2')];
      Object.assign(academicFixture, { sessionIds: [ses.id], courseIds: [course.id] });
      batchId = b1.id;
      otherBatchId = b2.id;
      for (const b of [b1, b2])
        await BatchTeacher.create({ instituteId, batchId: b.id, subjectId: null, teacherUserId: teacherId });
      await BatchStudent.create({
        instituteId,
        batchId,
        studentUserId: studentId,
        joinedOn: '2040-01-01',
        leftOn: null,
        promotedFromId: null,
      });
      const cs = await ClassSession.create({
        instituteId,
        branchId,
        batchId,
        subjectId: null,
        scheduleId: null,
        teacherUserId: teacherId,
        classroomId: null,
        date: '2040-02-01',
        startTime: '10:00',
        endTime: '11:30',
      });
      classSessionId = cs.id;
    });

    onLiveRecordingReady('test-lms', async (e) => {
      recordingEvents.push(e);
    });
    onLiveSessionEnded('test-attendance', async (e) => {
      endedEvents.push(e);
    });

    server = http.createServer(app);
    attachLiveSockets(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await closeLiveSockets();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await purgeAcademicFixtures({ batchIds: [batchId, otherBatchId], ...academicFixture });
  });

  it('schedules live classes from a class session or a batch', async () => {
    const res = await request(app)
      .post('/api/live-classes')
      .set(bearer(teacher))
      .send({ classSessionId, scheduledStartAt: '2040-02-01T04:30:00.000Z', title: 'Kinematics live' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      batchId,
      classSessionId,
      status: 'scheduled',
      myRole: 'host',
      title: 'Kinematics live',
      provider: 'dev-webrtc',
    });
    expect(Date.parse(res.body.scheduledEndAt) - Date.parse(res.body.scheduledStartAt)).toBe(90 * 60000);
    liveId = res.body.id;

    const dup = await request(app).post('/api/live-classes').set(bearer(teacher)).send({ classSessionId });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LIVE_SESSION_EXISTS');

    const other = await request(app).post('/api/live-classes').set(bearer(admin)).send({
      batchId: otherBatchId,
      teacherUserId: teacherId,
      scheduledStartAt: '2040-02-02T04:30:00.000Z',
      durationMinutes: 45,
    });
    expect(other.status).toBe(201);
    expect(other.body.myRole).toBe('moderator');
    otherLiveId = other.body.id;

    const patched = await request(app)
      .patch(`/api/live-classes/${otherLiveId}`)
      .set(bearer(teacher))
      .send({ title: 'Doubt clearing', durationMinutes: 60 });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Doubt clearing');
  });

  it('lets students see only classes of their batches and denies roles without access', async () => {
    const list = await request(app).get('/api/live-classes?upcoming=true').set(bearer(student));
    expect(list.status).toBe(200);
    const ids = list.body.items.map((i: { id: number }) => i.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(otherLiveId);
    expect((await request(app).get(`/api/live-classes/${otherLiveId}`).set(bearer(student))).status).toBe(
      404,
    );
    expect((await request(app).get(`/api/live-classes/${liveId}`).set(bearer(student))).body.myRole).toBe(
      'student',
    );

    expect(
      (await request(app).post('/api/live-classes').set(bearer(student)).send({ classSessionId })).status,
    ).toBe(403);
    expect((await request(app).get('/api/live-classes').set(bearer(parent))).status).toBe(403);
  });

  it('isolates tenants', async () => {
    expect((await request(app).get(`/api/live-classes/${liveId}`).set(bearer(zenith))).status).toBe(404);
    expect((await request(app).post(`/api/live-classes/${liveId}/start`).set(bearer(zenith))).status).toBe(
      404,
    );
    const list = await request(app).get('/api/live-classes').set(bearer(zenith));
    expect(list.body.items.map((i: { id: number }) => i.id)).not.toContain(liveId);
    const create = await request(app)
      .post('/api/live-classes')
      .set(bearer(zenith))
      .send({ batchId, instituteId: 1, scheduledStartAt: '2040-02-03T04:30:00.000Z' });
    expect(create.status).toBe(404);
  });

  it('starts only by the class teacher and issues join tokens to members', async () => {
    const early = await request(app).post(`/api/live-classes/${liveId}/join`).set(bearer(student));
    expect(early.status).toBe(409);
    expect((await request(app).post(`/api/live-classes/${liveId}/start`).set(bearer(student))).status).toBe(
      403,
    );
    const byAdmin = await request(app).post(`/api/live-classes/${liveId}/start`).set(bearer(admin));
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.code).toBe('NOT_CLASS_TEACHER');

    const started = await request(app).post(`/api/live-classes/${liveId}/start`).set(bearer(teacher));
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('live');

    const join = await request(app).post(`/api/live-classes/${liveId}/join`).set(bearer(student));
    expect(join.status).toBe(200);
    expect(join.body).toMatchObject({
      role: 'student',
      transport: 'socket-webrtc',
      socketPath: LIVE_SOCKET_PATH,
    });
    expect(join.body.iceServers.length).toBeGreaterThan(0);
    expect(new DevWebRtcStreamingProvider().verifyJoinToken(join.body.token)).toMatchObject({
      userId: studentId,
      role: 'viewer',
    });

    const hostJoin = await request(app).post(`/api/live-classes/${liveId}/join`).set(bearer(teacher));
    expect(hostJoin.body.role).toBe('host');
  });

  it('rejects unauthenticated or unauthorised sockets', async () => {
    await expect(connected(sock('not-a-token'))).rejects.toThrow();
    await expect(connected(sock(parent))).rejects.toThrow();
    const z = sock(zenith);
    await connected(z);
    const res = await emit(z, C.join, { sessionId: liveId });
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('runs the live room: chat, Q&A, polls, hands, mic, signalling, whiteboard, tracking', async () => {
    const t = sock(teacher);
    const s = sock(student);
    await Promise.all([connected(t), connected(s)]);

    const tJoin = await emit(t, C.join, { sessionId: liveId });
    expect(tJoin.ok).toBe(true);
    expect(tJoin.data.me.role).toBe('host');

    const joinedSeen = next(t, S.participantJoined);
    const sJoin = await emit(s, C.join, { sessionId: liveId });
    expect(sJoin.ok).toBe(true);
    expect(sJoin.data).toMatchObject({ hostOnline: true, me: { id: studentId, role: 'student' } });
    expect((await joinedSeen).id).toBe(studentId);

    // chat
    const chatSeen = next(t, S.chatMessage);
    expect((await emit(s, C.chatSend, { body: 'Hello sir' })).ok).toBe(true);
    expect((await chatSeen).body).toBe('Hello sir');

    // Q&A
    const asked = await emit(s, C.qaAsk, { body: 'What is velocity?' });
    const qid = asked.data.id;
    const up = await emit(s, C.qaUpvote, { id: qid });
    expect(up.data).toMatchObject({ upvotes: 1, upvotedByMe: true });
    expect((await emit(s, C.qaAnswer, { id: qid })).error?.code).toBe('NOT_CLASS_TEACHER');
    const answeredSeen = next(s, S.qaUpdate);
    expect((await emit(t, C.qaAnswer, { id: qid })).ok).toBe(true);
    expect(await answeredSeen).toMatchObject({ id: qid, isAnswered: true });

    // polls with live results
    expect((await emit(s, C.pollCreate, { question: 'x?', options: ['a', 'b'] })).ok).toBe(false);
    const pollSeen = next(s, S.pollUpdate);
    const poll = await emit(t, C.pollCreate, { question: 'Speed unit?', options: ['m/s', 'kg'] });
    expect(poll.ok).toBe(true);
    expect((await pollSeen).id).toBe(poll.data.id);
    const resultSeen = next(t, S.pollUpdate);
    const vote = await emit(s, C.pollVote, { id: poll.data.id, optionIndex: 0 });
    expect(vote.data).toMatchObject({ counts: [1, 0], myVote: 0 });
    expect((await resultSeen).counts).toEqual([1, 0]);
    expect((await emit(s, C.pollVote, { id: poll.data.id, optionIndex: 1 })).error?.code).toBe(
      'ALREADY_VOTED',
    );
    expect((await emit(t, C.pollClose, { id: poll.data.id })).data.status).toBe('closed');

    // raise hand → teacher grants mic → revokes
    const handsSeen = next(t, S.handsUpdate);
    await emit(s, C.handRaise);
    expect((await handsSeen).map((u: { id: number }) => u.id)).toEqual([studentId]);
    expect((await emit(s, C.micGrant, { userId: studentId })).ok).toBe(false);
    const speakersSeen = next(s, S.speakersUpdate);
    expect((await emit(t, C.micGrant, { userId: studentId })).ok).toBe(true);
    expect((await speakersSeen).map((u: { id: number }) => u.id)).toEqual([studentId]);
    const revoked = next(s, S.speakersUpdate);
    await emit(t, C.micRevoke, { userId: studentId });
    expect(await revoked).toEqual([]);

    // WebRTC signalling relayed teacher ↔ student only
    const offerSeen = next(s, S.rtcSignal);
    await emit(t, C.rtcSignal, { to: studentId, description: { type: 'offer', sdp: 'v=0' } });
    expect(await offerSeen).toMatchObject({ from: teacherId, description: { type: 'offer' } });
    const answerSeen = next(t, S.rtcSignal);
    await emit(s, C.rtcSignal, { to: teacherId, description: { type: 'answer', sdp: 'v=0' } });
    expect((await answerSeen).from).toBe(studentId);

    // whiteboard + screen share: teacher only
    const stroke = { id: 's1', tool: 'pen', color: '#ff0000', width: 3, points: [0.1, 0.1, 0.5, 0.5] };
    expect((await emit(s, C.wbStroke, stroke)).ok).toBe(false);
    const strokeSeen = next(s, S.wbStroke);
    await emit(t, C.wbStroke, stroke);
    expect((await strokeSeen).id).toBe('s1');
    expect((await emit(s, C.screenState, { sharing: true })).ok).toBe(false);
    const screenSeen = next(s, S.screenState);
    await emit(t, C.screenState, { sharing: true });
    expect(await screenSeen).toEqual({ sharing: true });

    // a late joiner gets the current room snapshot
    const s2 = sock(student);
    await connected(s2);
    const snap = await emit(s2, C.join, { sessionId: liveId });
    expect(snap.data.whiteboard.strokes).toHaveLength(1);
    expect(snap.data.screenSharing).toBe(true);
    expect(snap.data.chat).toHaveLength(1);
    expect(snap.data.polls[0]).toMatchObject({ myVote: 0, status: 'closed' });
    expect(snap.data.questions[0]).toMatchObject({ upvotedByMe: true, isAnswered: true });

    // leaving: the user only counts as left when their last socket disconnects
    s2.disconnect();
    const leftSeen = next(t, S.participantLeft);
    s.disconnect();
    expect((await leftSeen).userId).toBe(studentId);
    await new Promise((r) => setTimeout(r, 100));
    const p = await LiveParticipant.findOne({
      where: { instituteId: 1, liveSessionId: liveId, userId: studentId },
    });
    expect(p).toMatchObject({ isOnline: false, joinCount: 1, role: 'student' });

    const report = await request(app).get(`/api/live-classes/${liveId}/participants`).set(bearer(teacher));
    expect(report.status).toBe(200);
    expect(report.body.joinedStudents).toBe(1);
    expect(
      (await request(app).get(`/api/live-classes/${liveId}/participants`).set(bearer(student))).status,
    ).toBe(403);
  });

  it('stores teacher recordings and emits live.recording.ready', async () => {
    const file = Buffer.from('fake-webm-bytes');
    const bad = await request(app)
      .post(`/api/live-classes/${liveId}/recordings`)
      .set(bearer(student))
      .attach('file', file, { filename: 'r.webm', contentType: 'video/webm' });
    expect(bad.status).toBe(403);
    const notMedia = await request(app)
      .post(`/api/live-classes/${liveId}/recordings`)
      .set(bearer(teacher))
      .attach('file', file, { filename: 'r.txt', contentType: 'text/plain' });
    expect(notMedia.status).toBe(400);

    const res = await request(app)
      .post(`/api/live-classes/${liveId}/recordings`)
      .set(bearer(teacher))
      .field('durationSeconds', '42')
      .attach('file', file, { filename: 'r.webm', contentType: 'video/webm' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      liveSessionId: liveId,
      batchId,
      durationSeconds: 42,
      source: 'client-upload',
    });
    recordingId = res.body.id;

    await processDueJobs();
    expect(recordingEvents.find((e) => e.recordingId === recordingId)).toMatchObject({
      liveSessionId: liveId,
      batchId,
      fileId: res.body.fileId,
      mimeType: 'video/webm',
    });

    const list = await request(app).get(`/api/live-classes/recordings`).set(bearer(student));
    expect(list.body.map((r: { id: number }) => r.id)).toContain(recordingId);
    const url = await request(app)
      .get(`/api/live-classes/recordings/${recordingId}/url`)
      .set(bearer(student));
    expect(url.status).toBe(200);
    expect(url.body.url).toBeTruthy();
    expect(
      (await request(app).get(`/api/live-classes/recordings/${recordingId}/url`).set(bearer(zenith))).status,
    ).toBe(404);
  });

  it('ends the class, notifies sockets and emits live.session.ended for attendance', async () => {
    const t = sock(teacher);
    await connected(t);
    await emit(t, C.join, { sessionId: liveId });
    const endedSeen = next(t, S.sessionEnded);

    const ended = await request(app).post(`/api/live-classes/${liveId}/end`).set(bearer(teacher));
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('ended');
    expect(await endedSeen).toEqual({ sessionId: liveId });
    expect((await emit(t, C.chatSend, { body: 'late' })).error?.code).toBe('NOT_JOINED');

    await processDueJobs();
    const e = endedEvents.find((x) => x.liveSessionId === liveId)!;
    expect(e).toMatchObject({ classSessionId, batchId, absentStudentUserIds: [] });
    expect(e.participants.find((p) => p.userId === studentId)).toMatchObject({
      role: 'student',
      joinCount: 1,
    });
    expect(e.participants.find((p) => p.userId === teacherId)?.role).toBe('host');

    expect((await request(app).delete(`/api/live-classes/${liveId}`).set(bearer(teacher))).status).toBe(409);
  });

  it('cancels and deletes scheduled classes', async () => {
    const c = await request(app).post(`/api/live-classes/${otherLiveId}/cancel`).set(bearer(teacher));
    expect(c.body.status).toBe('cancelled');
    expect(
      (await request(app).post(`/api/live-classes/${otherLiveId}/start`).set(bearer(teacher))).status,
    ).toBe(409);
    expect((await request(app).delete(`/api/live-classes/${otherLiveId}`).set(bearer(student))).status).toBe(
      403,
    );
    expect((await request(app).delete(`/api/live-classes/${otherLiveId}`).set(bearer(teacher))).status).toBe(
      204,
    );
  });
});
