import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LIVE_CLIENT_EVENTS as C,
  LIVE_SERVER_EVENTS as S,
  LIVE_SOCKET_NAMESPACE,
  LIVE_SOCKET_PATH,
} from '@erp/shared';
import { config } from '../src/infrastructure/config';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { hashPassword } from '../src/infrastructure/password';
import { Job } from '../src/infrastructure/jobs/job.model';
import { LiveKitStreamingProvider, setStreamingProvider } from '../src/infrastructure/streaming';
import { presignS3Url } from '../src/infrastructure/streaming/s3-presign';
import { Device } from '../src/modules/authentication/models';
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
import {
  COLLECT_RECORDINGS_JOB,
  collectProviderRecordings,
  IMPORT_RECORDING_JOB,
} from '../src/modules/live-classes/live-classes.service';
import { LiveParticipant, LiveRecording } from '../src/modules/live-classes/models';
import {
  attachLiveSockets,
  closeLiveSockets,
  recheckLiveSockets,
} from '../src/modules/live-classes/realtime';
import { LmsResource, LmsResourceBatch } from '../src/modules/lms/models';
import { getSystemRole } from '../src/modules/permissions/catalog.service';
import { UserRole } from '../src/modules/permissions/models';
import { FfmpegTranscoder, setVideoTranscoder } from '../src/modules/lms/transcoder';
import { runWithContext } from '../src/shared/context';
import {
  DEMO_PASSWORD,
  USERS,
  bearer,
  getApp,
  idWatermarks,
  login,
  newDevice,
  purgeAcademicFixtures,
  purgeCreatedSince,
  purgeRows,
  stableDevice,
} from './helpers';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
/** Created here: it signs in on devices of its own (at most two are active per user). */
const STUDENT3 = { mobile: '9540000002', password: DEMO_PASSWORD };
const API_KEY = 'APIlk-test-key';
const API_SECRET = 'lk-test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const ACTIVE = new Set(['EGRESS_STARTING', 'EGRESS_ACTIVE']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON
type Json = Record<string, any>;
type Ack = { ok: boolean; data?: Json; error?: { code: string; message: string } };
interface TwirpCall {
  method: string;
  body: Json;
  grant: Json;
}

/** In-memory LiveKit server API (Twirp JSON) and S3 bucket: no network in tests. */
function fakeLiveKit() {
  const calls: TwirpCall[] = [];
  const failures = new Map<string, { status: number; body: Json }>();
  const egress: Json[] = [];
  /** Connected participants, by `<room>/<identity>`. */
  const participants = new Map<string, Json>();
  const s3: { method: string; url: URL }[] = [];
  let seq = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith('.s3.test')) {
      s3.push({ method: init?.method ?? 'GET', url });
      return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('s3-mp4-bytes');
    }
    const m = /^\/twirp\/livekit\.(RoomService|Egress)\/(\w+)$/.exec(url.pathname);
    if (url.origin !== 'https://lk.test' || !m) return new Response('no route', { status: 404 });
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const claims = jwt.verify(auth.replace(/^Bearer /, ''), API_SECRET, {
      algorithms: ['HS256'],
      issuer: API_KEY,
    }) as jwt.JwtPayload;
    const body = JSON.parse(String(init?.body ?? '{}')) as Json;
    const method = m[2];
    calls.push({ method, body, grant: claims.video as Json });
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      return Response.json(failure.body, { status: failure.status });
    }
    switch (method) {
      case 'CreateRoom':
        return Response.json({ sid: 'RM_test', name: body.name });
      case 'ListEgress':
        return Response.json({
          items: egress.filter((e) => e.roomName === body.roomName && (!body.active || ACTIVE.has(e.status))),
        });
      case 'StartRoomCompositeEgress': {
        const e = { egressId: `EG_start${++seq}`, roomName: body.roomName, status: 'EGRESS_STARTING' };
        egress.push(e);
        return Response.json(e);
      }
      case 'StopEgress': {
        const e = egress.find((x) => x.egressId === body.egressId);
        if (e) e.status = 'EGRESS_ENDING';
        return Response.json(e ?? {});
      }
      case 'ListRooms':
        return Response.json({ rooms: [{ name: 'erp-1-1' }, { name: 'erp-1-2' }] });
      case 'GetParticipant':
      case 'RemoveParticipant': {
        const key = `${body.room}/${body.identity}`;
        const p = participants.get(key);
        if (!p) return Response.json({ code: 'not_found', msg: 'participant not found' }, { status: 404 });
        if (method === 'GetParticipant') return Response.json(p);
        participants.delete(key);
        return Response.json({});
      }
      default:
        return Response.json({});
    }
  }) as typeof fetch;
  const lastCall = (method: string) => [...calls].reverse().find((c) => c.method === method);
  return { calls, failures, egress, participants, s3, fetch: fetchImpl, lastCall };
}

describe('LiveKit streaming provider', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let teacher: string;
  let student: string;
  let superAdmin: string;
  let branchId: number;
  let teacherId: number;
  let studentId: number;
  let student2Id: number;
  let student3Id: number;
  let batchId: number;
  let classSessionId: number;
  let liveId: number;
  let room: string;
  let recordingId: number;
  let marks: Record<string, number>;
  const academic: { sessionIds?: number[]; courseIds?: number[] } = {};

  const lk = fakeLiveKit();
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-recordings-'));
  const provider = new LiveKitStreamingProvider({
    url: 'wss://lk.test',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    roomPrefix: 'erp',
    recording: { output: 'local', egressDir: '/out', localDir: recDir },
    fetch: lk.fetch,
  });

  let server: http.Server;
  let baseUrl: string;
  const sockets: Socket[] = [];
  const sock = (token: string) => {
    const s = connect(`${baseUrl}${LIVE_SOCKET_NAMESPACE}`, {
      path: LIVE_SOCKET_PATH,
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(s);
    return new Promise<Socket>((resolve, reject) => {
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
    });
  };
  const emit = (s: Socket, event: string, payload: unknown = {}) =>
    new Promise<Ack>((resolve) => s.emit(event, payload, (r: Ack) => resolve(r)));

  /* ------------------------------------------------------------ webhooks as LiveKit signs them */

  const run = crypto.randomBytes(4).toString('hex');
  let eventSeq = 0;
  const sign = (
    raw: string,
    o: { secret?: string; issuer?: string; claims?: Json; expiresIn?: number } = {},
  ) =>
    jwt.sign(
      { sha256: crypto.createHash('sha256').update(raw).digest('base64'), video: {}, ...o.claims },
      o.secret ?? API_SECRET,
      { algorithm: 'HS256', issuer: o.issuer ?? API_KEY, ...(o.expiresIn ? { expiresIn: o.expiresIn } : {}) },
    );
  const deliver = (raw: string, authorization?: string, providerName = 'livekit') => {
    const req = request(app)
      .post(`/api/live-classes/public/${providerName}/webhook`)
      .set('Content-Type', 'application/webhook+json');
    if (authorization) req.set('Authorization', authorization);
    return req.send(raw);
  };
  const hook = (event: Json) => {
    const raw = JSON.stringify(event);
    return deliver(raw, sign(raw, { expiresIn: 300 }));
  };
  /** Protobuf JSON as LiveKit sends it: int64 fields are strings. */
  const participantEvent = (
    event: 'participant_joined' | 'participant_left' | 'participant_connection_aborted',
    p: { userId: number; sid: string; joinedAt: number; at: number; role?: string | null; deviceId?: number },
  ) => ({
    id: `EV_${run}_${++eventSeq}`,
    event,
    createdAt: String(p.at),
    room: { sid: 'RM_test', name: room },
    participant: {
      sid: p.sid,
      identity: `user-${p.userId}`,
      name: 'Someone',
      state: event === 'participant_joined' ? 'ACTIVE' : 'DISCONNECTED',
      joinedAt: String(p.joinedAt),
      joinedAtMs: String(p.joinedAt * 1000),
      ...(p.role === null
        ? {}
        : {
            metadata: JSON.stringify({
              role: p.role ?? 'viewer',
              ...(p.deviceId ? { deviceId: p.deviceId } : {}),
            }),
          }),
    },
  });
  const egressEnded = (egressId: string, filename: string, status = 'EGRESS_COMPLETE') => ({
    id: `EV_${run}_${++eventSeq}`,
    event: 'egress_ended',
    createdAt: String(Math.floor(Date.now() / 1000)),
    egressInfo: {
      egressId,
      roomId: 'RM_test',
      roomName: room,
      status,
      ...(status === 'EGRESS_COMPLETE'
        ? { fileResults: [{ filename: `/out/${filename}`, duration: '65000000000', size: '14' }] }
        : { error: 'Start signal not received' }),
    },
  });
  const participant = (userId: number) =>
    runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, () =>
      LiveParticipant.findOne({ where: { instituteId: 1, liveSessionId: liveId, userId } }),
    );

  beforeAll(async () => {
    app = await getApp();
    marks = await idWatermarks(['jobs', 'files']);
    [teacher, student, superAdmin] = (
      await Promise.all([login(USERS.apexTeacher), login(STUDENT), login(USERS.superAdmin)])
    ).map((l) => l.accessToken);
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    teacherId = (await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } }))!.id;
    studentId = (await User.findOne({ where: { mobile: STUDENT.mobile } }))!.id;
    // A second enrolled student who never logs in: only its media-room presence is reported.
    student2Id = (
      await User.create({
        name: 'LiveKit Student',
        mobile: '9540000001',
        email: null,
        passwordHash: null,
        lastLoginAt: null,
      })
    ).id;
    student3Id = (
      await User.create({
        name: 'LiveKit Device Student',
        mobile: STUDENT3.mobile,
        email: null,
        passwordHash: await hashPassword(STUDENT3.password),
        lastLoginAt: null,
      })
    ).id;
    await UserRole.create({
      userId: student3Id,
      roleId: (await getSystemRole('student')).id,
      instituteId: 1,
      branchId,
    });

    await runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, async () => {
      const instituteId = 1;
      const ses = await AcademicSession.create({
        instituteId,
        name: 'LiveKit 2041',
        startDate: '2041-01-01',
        endDate: '2041-12-31',
      });
      const course = await Course.create({
        instituteId,
        categoryId: null,
        templateId: null,
        name: 'LiveKit Course',
        code: 'LK-C1',
        description: null,
        durationValue: null,
        durationUnit: null,
      });
      Object.assign(academic, { sessionIds: [ses.id], courseIds: [course.id] });
      batchId = (
        await Batch.create({
          instituteId,
          branchId,
          courseId: course.id,
          academicSessionId: ses.id,
          name: 'LiveKit batch',
          code: 'LK-B1',
          capacity: 30,
          startDate: '2041-01-01',
          endDate: null,
        })
      ).id;
      await BatchTeacher.create({ instituteId, batchId, subjectId: null, teacherUserId: teacherId });
      for (const studentUserId of [studentId, student2Id, student3Id])
        await BatchStudent.create({
          instituteId,
          batchId,
          studentUserId,
          joinedOn: '2041-01-01',
          leftOn: null,
          promotedFromId: null,
        });
      classSessionId = (
        await ClassSession.create({
          instituteId,
          branchId,
          batchId,
          subjectId: null,
          scheduleId: null,
          teacherUserId: teacherId,
          classroomId: null,
          date: '2041-02-01',
          startTime: '10:00',
          endTime: '11:00',
        })
      ).id;
    });

    setStreamingProvider(provider);
    server = http.createServer(app);
    attachLiveSockets(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await closeLiveSockets();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setStreamingProvider(null);
    setVideoTranscoder(new FfmpegTranscoder());
    await purgeAcademicFixtures({ batchIds: [batchId], ...academic });
    await purgeCreatedSince(marks);
    await purgeRows('users', [student2Id, student3Id]);
    fs.rmSync(recDir, { recursive: true, force: true });
  });

  it('creates the room, starts Egress recording and issues per-role join tokens', async () => {
    const created = await request(app)
      .post('/api/live-classes')
      .set(bearer(teacher))
      .send({ classSessionId, title: 'Optics live' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ provider: 'livekit', recordingEnabled: true });
    liveId = created.body.id;
    room = `erp-1-${liveId}`;

    // Students cannot get media credentials before the class starts.
    expect((await request(app).post(`/api/live-classes/${liveId}/join`).set(bearer(student))).status).toBe(
      409,
    );

    lk.failures.set('CreateRoom', { status: 503, body: { code: 'unavailable', msg: 'server draining' } });
    const down = await request(app).post(`/api/live-classes/${liveId}/start`).set(bearer(teacher));
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('STREAMING_UNAVAILABLE');

    const started = await request(app).post(`/api/live-classes/${liveId}/start`).set(bearer(teacher));
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('live');
    expect(lk.lastCall('CreateRoom')).toMatchObject({
      body: { name: room, emptyTimeout: 600, departureTimeout: 120 },
      grant: { roomCreate: true },
    });
    expect(lk.lastCall('StartRoomCompositeEgress')).toMatchObject({
      body: {
        roomName: room,
        layout: 'speaker',
        fileOutputs: [{ fileType: 'MP4', filepath: '/out/', disableManifest: true }],
      },
      grant: { roomRecord: true },
    });

    const join = await request(app).post(`/api/live-classes/${liveId}/join`).set(bearer(student));
    expect(join.status).toBe(200);
    expect(join.body).toMatchObject({
      provider: 'livekit',
      transport: 'vendor-sdk',
      roomId: room,
      url: 'wss://lk.test',
      iceServers: [],
      role: 'student',
    });
    const viewer = jwt.verify(join.body.token, API_SECRET, { issuer: API_KEY }) as jwt.JwtPayload;
    expect(viewer.sub).toBe(`user-${studentId}`);
    const studentDevice = await Device.findOne({ where: { deviceUid: stableDevice(STUDENT.mobile).uid } });
    // The device it was issued to, so signing that device out can remove it from the room.
    expect(JSON.parse(viewer.metadata)).toEqual({ role: 'viewer', deviceId: studentDevice!.id });
    expect(viewer.video).toEqual({
      room,
      roomJoin: true,
      canUpdateOwnMetadata: false,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    });
    expect(viewer.exp! - viewer.iat!).toBeLessThanOrEqual(15 * 60);

    const hostJoin = await request(app).post(`/api/live-classes/${liveId}/join`).set(bearer(teacher));
    const host = jwt.verify(hostJoin.body.token, API_SECRET) as jwt.JwtPayload;
    expect(host.video).toMatchObject({
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio'],
    });
  });

  it('accepts only webhooks signed with the API key and secret, once each', async () => {
    const event = participantEvent('participant_joined', {
      userId: studentId,
      sid: 'PA_forged',
      joinedAt: 1,
      at: 1,
    });
    const raw = JSON.stringify(event);
    const rejected = [
      await deliver(raw),
      await deliver(raw, 'not-a-jwt'),
      await deliver(raw, sign(raw, { secret: 'some-other-secret-0123456789abcdef', expiresIn: 300 })),
      await deliver(raw, sign(raw, { issuer: 'APIother', expiresIn: 300 })),
      await deliver(raw, sign(raw)), // LiveKit tokens always expire
      await deliver(raw, sign(raw, { claims: { exp: Math.floor(Date.now() / 1000) - 600 } })),
      await deliver(raw.replace('PA_forged', 'PA_tamper'), sign(raw, { expiresIn: 300 })),
    ];
    for (const res of rejected) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    }
    expect(await participant(studentId)).toBeNull();

    // Only the active provider has a webhook.
    expect((await deliver(raw, sign(raw, { expiresIn: 300 }), 'dev-webrtc')).status).toBe(404);
    expect((await deliver(raw, sign(raw, { expiresIn: 300 }), 'Bad_Name')).status).toBe(422);
    const unreadable = 'not json';
    expect((await deliver(unreadable, sign(unreadable, { expiresIn: 300 }))).status).toBe(400);

    // Rooms this deployment did not create, or another institute's room name, change nothing.
    for (const name of ['someone-elses-room', `erp-2-${liveId}`, `erp-1-${liveId + 100000}`]) {
      const res = await hook({ ...event, id: `EV_${run}_${++eventSeq}`, room: { name } });
      expect(res.body).toEqual({ received: true, ignored: true });
    }

    const started = { id: `EV_${run}_started`, event: 'room_started', room: { name: room }, createdAt: '1' };
    expect((await hook(started)).body).toEqual({ received: true });
    expect((await hook(started)).body).toEqual({ received: true, duplicate: true });
  });

  it('records attendance from media-room joins and leaves (reconnects, late and lost events)', async () => {
    const t0 = Math.floor(Date.now() / 1000) - 1800;
    const ok = async (e: Json) => expect((await hook(e)).body).toEqual({ received: true });

    await ok(
      participantEvent('participant_joined', { userId: studentId, sid: 'PA_s1', joinedAt: t0, at: t0 }),
    );
    expect(await participant(studentId)).toMatchObject({ role: 'student', isOnline: true, joinCount: 1 });
    await ok(
      participantEvent('participant_left', { userId: studentId, sid: 'PA_s1', joinedAt: t0, at: t0 + 60 }),
    );
    expect(await participant(studentId)).toMatchObject({ isOnline: false, totalSeconds: 60 });

    // Reconnect through a new connection before the old one's leave arrives.
    await ok(
      participantEvent('participant_joined', {
        userId: studentId,
        sid: 'PA_s2',
        joinedAt: t0 + 120,
        at: t0 + 120,
      }),
    );
    await ok(
      participantEvent('participant_joined', {
        userId: studentId,
        sid: 'PA_s3',
        joinedAt: t0 + 150,
        at: t0 + 150,
      }),
    );
    await ok(
      participantEvent('participant_left', {
        userId: studentId,
        sid: 'PA_s2',
        joinedAt: t0 + 120,
        at: t0 + 160,
      }),
    );
    expect(await participant(studentId)).toMatchObject({ isOnline: true, joinCount: 2 });
    await ok(
      participantEvent('participant_left', {
        userId: studentId,
        sid: 'PA_s3',
        joinedAt: t0 + 150,
        at: t0 + 180,
      }),
    );
    expect(await participant(studentId)).toMatchObject({ isOnline: false, joinCount: 2, totalSeconds: 120 });

    // The leave overtakes the join (no token metadata: the role comes from the batch); the late join is a no-op.
    const left = { userId: student2Id, sid: 'PA_o1', joinedAt: t0 + 10, at: t0 + 70, role: null };
    await ok(participantEvent('participant_left', left));
    await ok(participantEvent('participant_joined', { ...left, at: t0 + 10 }));
    expect(await participant(student2Id)).toMatchObject({
      role: 'student',
      isOnline: false,
      joinCount: 1,
      totalSeconds: 60,
    });
    // A connection that never got media through adds no time.
    await ok(
      participantEvent('participant_connection_aborted', {
        userId: student2Id,
        sid: 'PA_o2',
        joinedAt: t0 + 300,
        at: t0 + 305,
      }),
    );
    expect(await participant(student2Id)).toMatchObject({ joinCount: 1, totalSeconds: 60 });

    // Egress and other non-user participants are not attendance.
    const recorder = participantEvent('participant_joined', {
      userId: 0,
      sid: 'PA_eg',
      joinedAt: t0,
      at: t0,
    });
    recorder.participant.identity = 'EG_recorder';
    expect((await hook(recorder)).body).toEqual({ received: true, ignored: true });

    // The teacher's join makes sure the recording runs (here it already does: no second Egress).
    const starts = lk.calls.filter((c) => c.method === 'StartRoomCompositeEgress').length;
    await ok(
      participantEvent('participant_joined', {
        userId: teacherId,
        sid: 'PA_t1',
        joinedAt: t0,
        at: t0,
        role: 'host',
      }),
    );
    expect(await participant(teacherId)).toMatchObject({ role: 'host', isOnline: true });
    await processDueJobs();
    expect(lk.lastCall('ListEgress')?.body).toEqual({ roomName: room, active: true });
    expect(lk.calls.filter((c) => c.method === 'StartRoomCompositeEgress')).toHaveLength(starts);
  });

  it('applies the teacher microphone decision on the media server; socket presence is not attendance', async () => {
    const [t, s] = await Promise.all([sock(teacher), sock(student)]);
    expect((await emit(t, C.join, { sessionId: liveId })).ok).toBe(true);
    expect((await emit(s, C.join, { sessionId: liveId })).ok).toBe(true);
    // LiveKit webhooks are the attendance source: the classroom socket does not mark the student online.
    expect(await participant(studentId)).toMatchObject({ isOnline: false, joinCount: 2 });

    await emit(s, C.handRaise);
    lk.failures.set('UpdateParticipant', {
      status: 404,
      body: { code: 'not_found', msg: 'participant not found' },
    });
    expect((await emit(t, C.micGrant, { userId: studentId })).error?.code).toBe('MEDIA_NOT_CONNECTED');

    const speakers = new Promise<Json[]>((resolve) => s.once(S.speakersUpdate, resolve));
    expect((await emit(t, C.micGrant, { userId: studentId })).ok).toBe(true);
    expect((await speakers).map((u) => u.id)).toEqual([studentId]);
    expect(lk.lastCall('UpdateParticipant')).toMatchObject({
      body: {
        room,
        identity: `user-${studentId}`,
        permission: {
          canPublish: true,
          canSubscribe: true,
          canPublishData: false,
          canPublishSources: ['MICROPHONE'],
        },
      },
      grant: { roomAdmin: true, room },
    });

    await emit(t, C.micRevoke, { userId: studentId });
    await vi.waitFor(() =>
      expect(lk.lastCall('UpdateParticipant')?.body.permission).toEqual({
        canSubscribe: true,
        canPublish: false,
        canPublishData: false,
        canPublishSources: [],
      }),
    );
    t.disconnect();
    s.disconnect();
  });

  it('removes a device that signs out, is revoked or loses access from the media room', async () => {
    const t0 = Math.floor(Date.now() / 1000) - 600;
    const identity = `user-${student3Id}`;
    const connected = () => lk.participants.has(`${room}/${identity}`);
    /** LiveKit has the connection before it reports it. */
    const connect = async (deviceId: number, sid: string, at: number) => {
      lk.participants.set(`${room}/${identity}`, {
        sid,
        identity,
        metadata: JSON.stringify({ role: 'viewer', deviceId }),
      });
      const joined = participantEvent('participant_joined', {
        userId: student3Id,
        sid,
        joinedAt: at,
        at,
        deviceId,
      });
      expect((await hook(joined)).body).toEqual({ received: true });
    };
    const leave = async (deviceId: number, sid: string, joinedAt: number, at: number) => {
      const left = participantEvent('participant_left', { userId: student3Id, sid, joinedAt, at, deviceId });
      expect((await hook(left)).body).toEqual({ received: true });
    };
    const removals = () => lk.calls.filter((c) => c.method === 'RemoveParticipant' && c.body.room === room);
    const deviceIdOf = async (uid: string) => (await Device.findOne({ where: { deviceUid: uid } }))!.id;

    const phone = await login(STUDENT3, newDevice('android'));
    const phoneId = await deviceIdOf(phone.device.uid);
    const join = await request(app).post(`/api/live-classes/${liveId}/join`).set(bearer(phone.accessToken));
    const claims = jwt.verify(join.body.token, API_SECRET) as jwt.JwtPayload;
    expect(JSON.parse(claims.metadata)).toEqual({ role: 'viewer', deviceId: phoneId });
    await connect(phoneId, 'PA_p1', t0);
    const s = await sock(phone.accessToken);
    expect((await emit(s, C.join, { sessionId: liveId })).ok).toBe(true);
    expect(await participant(student3Id)).toMatchObject({ isOnline: true, joinCount: 1 });

    // Signing out drops the device's classroom socket and its media connection (device event job).
    const signedOut = new Promise<string>((resolve) => s.once('disconnect', resolve));
    const logout = await request(app).post('/api/auth/logout').send({ refreshToken: phone.refreshToken });
    expect(logout.status).toBe(204);
    await processDueJobs();
    expect(await signedOut).toBe('io server disconnect');
    expect(lk.lastCall('GetParticipant')).toMatchObject({
      body: { room, identity },
      grant: { roomAdmin: true, room },
    });
    expect(removals()).toHaveLength(1);
    expect(removals()[0]).toMatchObject({ body: { room, identity }, grant: { roomAdmin: true, room } });
    expect(connected()).toBe(false);
    await leave(phoneId, 'PA_p1', t0, t0 + 60);
    expect(await participant(student3Id)).toMatchObject({ isOnline: false, joinCount: 1, totalSeconds: 60 });

    // Its join token still lets it connect for a while: LiveKit's join is refused and adds no visit.
    await connect(phoneId, 'PA_p2', t0 + 120);
    expect(removals()).toHaveLength(2);
    expect(connected()).toBe(false);
    await leave(phoneId, 'PA_p2', t0 + 120, t0 + 180);
    expect(await participant(student3Id)).toMatchObject({ isOnline: false, joinCount: 1, totalSeconds: 60 });

    // The minute re-check drops a socket whose user lost access, and that seat's media connection.
    const laptop = await login(STUDENT3, newDevice('web'));
    const laptopId = await deviceIdOf(laptop.device.uid);
    await connect(laptopId, 'PA_l1', t0 + 240);
    const l = await sock(laptop.accessToken);
    expect((await emit(l, C.join, { sessionId: liveId })).ok).toBe(true);
    await User.update({ status: 'inactive' }, { where: { id: student3Id } });
    try {
      const deactivated = new Promise<string>((resolve) => l.once('disconnect', resolve));
      expect(await recheckLiveSockets()).toBe(1);
      expect(await deactivated).toBe('io server disconnect');
      expect(removals()).toHaveLength(3);
      expect(connected()).toBe(false);
    } finally {
      await User.update({ status: 'active' }, { where: { id: student3Id } });
    }

    // Revoking a device removes only a connection made with that device's token.
    await connect(laptopId, 'PA_l2', t0 + 300);
    const revoke = (deviceId: number) =>
      request(app).delete(`/api/auth/devices/${deviceId}`).set(bearer(laptop.accessToken));
    expect((await revoke(phoneId)).status).toBe(204);
    await processDueJobs();
    expect(removals()).toHaveLength(3);
    expect(connected()).toBe(true);
    expect((await revoke(laptopId)).status).toBe(204);
    await processDueJobs();
    expect(removals()).toHaveLength(4);
    expect(connected()).toBe(false);
  });

  it('imports finished recordings into storage, links them to the batch and course, and streams HLS', async () => {
    setVideoTranscoder({
      available: async () => true,
      toHls: async (_input, outDir) => {
        await fs.promises.mkdir(outDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(outDir, 'index.m3u8'),
          '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg_00000.ts\n#EXT-X-ENDLIST\n',
        );
        await fs.promises.writeFile(path.join(outDir, 'seg_00000.ts'), Buffer.alloc(188, 0x47));
        return ['index.m3u8', 'seg_00000.ts'];
      },
    });
    const file = `${room}-2041-02-01T100000.mp4`;
    fs.writeFileSync(path.join(recDir, file), 'egress-mp4-bytes');

    const failed = await hook(egressEnded('EG_failed', 'x.mp4', 'EGRESS_FAILED'));
    expect(failed.body).toEqual({ received: true });
    const ended = egressEnded('EG_part1', file);
    expect((await hook(ended)).body).toEqual({ received: true });
    expect((await hook(ended)).body).toEqual({ received: true, duplicate: true });
    await processDueJobs();

    const recs = await runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, () =>
      LiveRecording.findAll({ where: { instituteId: 1, liveSessionId: liveId } }),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      batchId,
      courseId: academic.courseIds![0],
      source: 'provider',
      providerRef: 'EG_part1',
      durationSeconds: 65,
      title: 'Optics live',
    });
    recordingId = recs[0].id;
    // The Egress copy is removed once the API stored its own.
    expect(fs.existsSync(path.join(recDir, file))).toBe(false);

    const resource = await runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, () =>
      LmsResource.findOne({
        where: { instituteId: 1, sourceRef: `live-recording:${recordingId}` },
        include: [{ model: LmsResourceBatch, as: 'batchLinks' }],
      }),
    );
    expect(resource).toMatchObject({
      courseId: academic.courseIds![0],
      type: 'video',
      status: 'published',
      fileId: recs[0].fileId,
      transcodeStatus: 'ready',
    });
    expect(resource!.batchLinks!.map((l) => l.batchId)).toEqual([batchId]);

    const url = (format?: string) =>
      request(app)
        .get(`/api/live-classes/recordings/${recordingId}/url${format ? `?format=${format}` : ''}`)
        .set(bearer(student));
    const plain = await url();
    expect(plain.body).toMatchObject({ kind: 'file', mimeType: 'video/mp4' });
    expect(plain.body.url).toContain('/api/files/signed/');
    const hls = await url('hls');
    expect(hls.body).toMatchObject({ kind: 'hls', mimeType: 'application/vnd.apple.mpegurl' });
    expect(hls.body.url).toMatch(/\/api\/lms\/public\/hls\/[^/]+\/index\.m3u8$/);
    const playlist = await request(app).get(new URL(hls.body.url).pathname);
    expect(playlist.status).toBe(200);
    expect(playlist.text).toContain('seg_00000.ts');
    expect((await url('dash')).status).toBe(422);
  });

  it('ends the room and collects recordings whose webhook was missed', async () => {
    const ended = await request(app).post(`/api/live-classes/${liveId}/end`).set(bearer(teacher));
    expect(ended.status).toBe(200);
    expect(lk.lastCall('StopEgress')?.body).toEqual({ egressId: 'EG_start1' });
    expect(lk.lastCall('DeleteRoom')?.body).toEqual({ room });
    expect(await participant(teacherId)).toMatchObject({ isOnline: false });

    const collect = (await Job.findAll({ where: { name: COLLECT_RECORDINGS_JOB } })).find(
      (j) => j.payload.liveSessionId === liveId,
    );
    expect(+collect!.runAt - Date.now()).toBeGreaterThan(10 * 60_000);

    // After the end, presence events change nothing.
    const before = (await participant(studentId))!.totalSeconds;
    const late = Math.floor(Date.now() / 1000);
    await hook(
      participantEvent('participant_joined', { userId: studentId, sid: 'PA_late', joinedAt: late, at: late }),
    );
    expect(await participant(studentId)).toMatchObject({ isOnline: false, totalSeconds: before });

    const part2 = `${room}-2041-02-01T103000.mp4`;
    fs.writeFileSync(path.join(recDir, part2), 'egress-mp4-part-2');
    lk.egress.push(
      {
        egressId: 'EG_part1',
        roomName: room,
        status: 'EGRESS_COMPLETE',
        fileResults: [{ filename: `/out/${room}-2041-02-01T100000.mp4` }],
      },
      {
        egressId: 'EG_part2',
        roomName: room,
        status: 'EGRESS_COMPLETE',
        fileResults: [{ filename: `/out/${part2}` }],
      },
      { egressId: 'EG_writing', roomName: room, status: 'EGRESS_ENDING' },
    );
    const jobs = await idWatermarks(['jobs']);
    await runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, () =>
      collectProviderRecordings({ liveSessionId: liveId }),
    );
    const queued = await Job.findAll({ where: { id: { [Op.gt]: jobs.jobs } }, order: [['id', 'ASC']] });
    expect(queued.map((j) => [j.name, j.payload.ref ?? j.payload.attempt])).toEqual([
      [IMPORT_RECORDING_JOB, 'EG_part2'],
      [COLLECT_RECORDINGS_JOB, 2],
    ]);
    await processDueJobs();
    const titles = await runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, () =>
      LiveRecording.findAll({ where: { instituteId: 1, liveSessionId: liveId }, order: [['id', 'ASC']] }),
    );
    expect(titles.map((r) => [r.providerRef, r.title])).toEqual([
      ['EG_part1', 'Optics live'],
      ['EG_part2', 'Optics live (part 2)'],
    ]);
    expect(fs.existsSync(path.join(recDir, part2))).toBe(false);
  });

  it('shows platform admins the webhook URL and checks the connection without exposing the secret', async () => {
    expect((await request(app).get('/api/admin/live-streaming').set(bearer(teacher))).status).toBe(403);
    const status = await request(app).get('/api/admin/live-streaming').set(bearer(superAdmin));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      provider: 'livekit',
      transport: 'vendor-sdk',
      webhookUrl: `${config.API_PUBLIC_URL}/api/live-classes/public/livekit/webhook`,
      canTest: true,
      settings: {
        url: 'wss://lk.test',
        apiUrl: 'https://lk.test',
        apiKey: 'APIl…',
        recordingOutput: 'local',
      },
    });
    expect(Date.parse(status.body.lastWebhookAt)).toBeGreaterThan(Date.now() - 600_000);
    expect(JSON.stringify(status.body)).not.toContain(API_SECRET);

    const test = () => request(app).post('/api/admin/live-streaming/test').set(bearer(superAdmin));
    const good = await test();
    expect(good.body.ok).toBe(true);
    expect(good.body.message).toContain('Connected to LiveKit at https://lk.test (2 active rooms)');
    lk.failures.set('ListRooms', { status: 401, body: { code: 'unauthenticated', msg: 'invalid API key' } });
    const bad = await test();
    expect(bad.body.ok).toBe(false);
    expect(bad.body.message).toContain('LIVEKIT_API_KEY');
    expect(bad.body.message).not.toContain(API_SECRET);

    // The default dev provider has no webhook and nothing to check.
    setStreamingProvider(null);
    try {
      const dev = await request(app).get('/api/admin/live-streaming').set(bearer(superAdmin));
      expect(dev.body).toMatchObject({
        provider: 'dev-webrtc',
        transport: 'socket-webrtc',
        webhookUrl: null,
      });
      expect((await test()).body.ok).toBe(true);
      const raw = '{}';
      expect((await deliver(raw, sign(raw, { expiresIn: 300 }))).status).toBe(404);
    } finally {
      setStreamingProvider(provider);
    }
  });

  it('stages LiveKit Cloud recordings in S3 with presigned requests (AWS Signature V4)', async () => {
    // AWS documentation example: "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)".
    const url = presignS3Url(
      {
        bucket: 'examplebucket',
        region: 'us-east-1',
        endpoint: 'https://s3.amazonaws.com',
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      { method: 'GET', key: 'test.txt', expiresInSeconds: 86400, now: new Date('2013-05-24T00:00:00Z') },
    );
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );

    const cloud = new LiveKitStreamingProvider({
      url: 'wss://lk.test',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      roomPrefix: 'erp',
      recording: {
        output: 's3',
        bucket: 'staging',
        region: 'auto',
        endpoint: 'https://acct.s3.test',
        forcePathStyle: true,
        accessKey: 'AKSTAGING',
        secretKey: 'staging-secret',
      },
      fetch: lk.fetch,
    });
    await cloud.startRecording('erp-1-999999');
    expect(lk.lastCall('StartRoomCompositeEgress')?.body.fileOutputs).toEqual([
      {
        fileType: 'MP4',
        filepath: 'livekit-recordings/',
        disableManifest: true,
        s3: {
          accessKey: 'AKSTAGING',
          secret: 'staging-secret',
          region: 'auto',
          bucket: 'staging',
          endpoint: 'https://acct.s3.test',
          forcePathStyle: true,
        },
      },
    ]);

    const rec = {
      ref: 'EG_cloud',
      location: 'livekit-recordings/erp-1-9-x.mp4',
      mimeType: 'video/mp4',
      durationSeconds: 5,
    };
    const dest = path.join(recDir, 'downloaded.mp4');
    await cloud.fetchRecording(rec, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('s3-mp4-bytes');
    await cloud.discardRecording(rec);
    expect(lk.s3.map((r) => [r.method, r.url.pathname, r.url.searchParams.has('X-Amz-Signature')])).toEqual([
      ['GET', '/staging/livekit-recordings/erp-1-9-x.mp4', true],
      ['DELETE', '/staging/livekit-recordings/erp-1-9-x.mp4', true],
    ]);
    // Only objects under the staging prefix, never other keys of the bucket.
    for (const location of ['other/secret.mp4', 'livekit-recordings/../other.mp4'])
      await expect(cloud.fetchRecording({ ...rec, location }, dest)).rejects.toThrow('Unexpected');
    await expect(provider.fetchRecording({ ...rec, location: '../escape.mp4' }, dest)).rejects.toThrow(
      'Unexpected',
    );
  });
});
