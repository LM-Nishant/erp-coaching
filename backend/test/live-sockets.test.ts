import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from 'redis';
import type { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INSTITUTE_IDLE_TIMEOUT_SETTING,
  LIVE_CLIENT_EVENTS as C,
  LIVE_SERVER_EVENTS as S,
  LIVE_SOCKET_NAMESPACE,
  LIVE_SOCKET_PATH,
  type LiveUserRef,
} from '@erp/shared';
import { config } from '../src/infrastructure/config';
import { closeRedis } from '../src/infrastructure/redis';
import { runWithContext } from '../src/shared/context';
import { clearIdleTimeoutCache } from '../src/shared/session-policy';
import { AcademicSession, Batch, BatchStudent, Course } from '../src/modules/academics/models';
import { Device } from '../src/modules/authentication/models';
import { InstituteSetting } from '../src/modules/institutes/institute-setting.model';
import { Subscription } from '../src/modules/subscriptions/models';
import { invalidateAccess } from '../src/modules/subscriptions/api';
import { LiveParticipant, LiveSession } from '../src/modules/live-classes/models';
import {
  attachLiveSockets,
  closeLiveSockets,
  disconnectDeviceSockets,
  recheckLiveSockets,
} from '../src/modules/live-classes/realtime';
import { getApp } from './helpers';
import {
  type Actor,
  type Tenant,
  createInstitute,
  createStaff,
  createSuperAdmin,
  ok,
  purgeInstitutes,
} from './security/harness';

/** Open live-class sockets are re-checked, and work across API instances with Redis. Mobiles 9502…. */
const PREFIX = '9502';
let n = 0;
const mobile = () => `${PREFIX}${String(n++).padStart(6, '0')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed socket acks
type Ack = { ok: boolean; data?: any; error?: { code: string; message: string } };

let superAdmin: Actor;
let tenant: Tenant;
let teacher: Actor;
let student: Actor;
let liveId: number;
const sockets: Socket[] = [];

function sock(baseUrl: string, token: string) {
  const s = connect(`${baseUrl}${LIVE_SOCKET_NAMESPACE}`, {
    path: LIVE_SOCKET_PATH,
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(s);
  return s;
}
const connected = (s: Socket) =>
  new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', reject);
  });
const emit = (s: Socket, event: string, payload: unknown = {}) =>
  new Promise<Ack>((resolve) => s.emit(event, payload, (r: Ack) => resolve(r)));
const next = <T = unknown>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));
const dropped = (s: Socket) => next<string>(s, 'disconnect');
const ids = (users: LiveUserRef[]) => users.map((u) => u.id);

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function setSuspended(suspended: boolean) {
  await Subscription.update(
    { suspendedAt: suspended ? new Date() : null },
    { where: { instituteId: tenant.id } },
  );
  invalidateAccess(tenant.id);
}
const deviceOf = async (who: Actor) =>
  (await Device.findOne({ where: { userId: who.userId, status: 'active' }, order: [['id', 'DESC']] }))!;

beforeAll(async () => {
  superAdmin = await createSuperAdmin(mobile());
  const tag = `live${crypto.randomBytes(3).toString('hex')}`;
  tenant = await createInstitute(superAdmin, {
    slug: tag,
    name: `Live sockets ${tag}`,
    adminMobile: mobile(),
    label: 'admin',
  });
  const staff = (label: string) =>
    createStaff(tenant.admin, {
      label,
      mobile: mobile(),
      permissions: ['live-classes.view'],
      branchId: tenant.mainBranchId,
    });
  teacher = await staff('teacher');
  student = await staff('student');
  const instituteId = tenant.id;
  await runWithContext({ system: true, instituteId, allowedBranchIds: null }, async () => {
    const session = await AcademicSession.create({
      instituteId,
      name: 'Live sockets 2040',
      startDate: '2040-01-01',
      endDate: '2040-12-31',
    });
    const course = await Course.create({
      instituteId,
      categoryId: null,
      templateId: null,
      name: 'Live sockets course',
      code: 'LS-C1',
      description: null,
      durationValue: null,
      durationUnit: null,
    });
    const batch = await Batch.create({
      instituteId,
      branchId: tenant.mainBranchId,
      courseId: course.id,
      academicSessionId: session.id,
      name: 'Live sockets batch',
      code: 'LS-B1',
      capacity: 30,
      startDate: '2040-01-01',
      endDate: null,
    });
    await BatchStudent.create({
      instituteId,
      batchId: batch.id,
      studentUserId: student.userId,
      joinedOn: '2040-01-01',
      leftOn: null,
      promotedFromId: null,
    });
    const live = await LiveSession.create({
      instituteId,
      branchId: tenant.mainBranchId,
      batchId: batch.id,
      courseId: course.id,
      subjectId: null,
      classSessionId: null,
      teacherUserId: teacher.userId,
      title: 'Live sockets class',
      description: null,
      scheduledStartAt: new Date(),
      scheduledEndAt: new Date(Date.now() + 3_600_000),
      status: 'live',
      startedAt: new Date(),
      provider: 'dev-webrtc',
    });
    liveId = live.id;
  });
}, 120_000);

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await closeLiveSockets();
  if (tenant) {
    invalidateAccess(tenant.id);
    clearIdleTimeoutCache(tenant.id);
  }
  await purgeInstitutes([tenant?.id], PREFIX);
}, 120_000);

describe('re-checking open live-class sockets', () => {
  let baseUrl: string;

  beforeAll(async () => {
    const server = http.createServer(await getApp());
    attachLiveSockets(server);
    baseUrl = await listen(server);
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await closeLiveSockets();
  });

  it('drops them when the subscription is suspended or the institute deactivated', async () => {
    const t = sock(baseUrl, teacher.token);
    await connected(t);
    expect((await emit(t, C.join, { sessionId: liveId })).ok).toBe(true);
    const suspended = dropped(t);
    await setSuspended(true);
    try {
      expect(await suspended).toBe('io server disconnect');
      // The teacher counts as having left.
      await expect
        .poll(async () =>
          runWithContext(
            { system: true, instituteId: tenant.id, allowedBranchIds: null },
            async () =>
              (
                await LiveParticipant.findOne({
                  where: { instituteId: tenant.id, liveSessionId: liveId, userId: teacher.userId },
                })
              )?.isOnline,
          ),
        )
        .toBe(false);
      const refused = sock(baseUrl, teacher.token);
      await expect(connected(refused)).rejects.toMatchObject({ data: { code: 'SUBSCRIPTION_SUSPENDED' } });
    } finally {
      await setSuspended(false);
    }

    const again = sock(baseUrl, teacher.token);
    await connected(again);
    const deactivated = dropped(again);
    await ok(superAdmin, 'POST', `/api/admin/institutes/${tenant.id}/status`, { status: 'inactive' });
    try {
      expect(await deactivated).toBe('io server disconnect');
    } finally {
      await ok(superAdmin, 'POST', `/api/admin/institutes/${tenant.id}/status`, { status: 'active' });
    }
  });

  it('drops the sockets of idle devices and keeps the others', async () => {
    const t = sock(baseUrl, teacher.token);
    const s = sock(baseUrl, student.token);
    await Promise.all([connected(t), connected(s)]);
    await InstituteSetting.create({ instituteId: tenant.id, key: INSTITUTE_IDLE_TIMEOUT_SETTING, value: 15 });
    clearIdleTimeoutCache(tenant.id);
    try {
      await Device.update(
        { lastSeenAt: new Date(Date.now() - 20 * 60_000) },
        { where: { id: (await deviceOf(student)).id } },
      );
      const idle = dropped(s);
      expect(await recheckLiveSockets()).toBe(1);
      expect(await idle).toBe('io server disconnect');
      expect(t.connected).toBe(true);
    } finally {
      await InstituteSetting.destroy({
        where: { instituteId: tenant.id, key: INSTITUTE_IDLE_TIMEOUT_SETTING },
      });
      clearIdleTimeoutCache(tenant.id);
      await Device.update({ lastSeenAt: new Date() }, { where: { id: (await deviceOf(student)).id } });
    }
  });
});

describe.skipIf(!process.env.TEST_REDIS_URL)('live classes across API instances (Redis)', () => {
  const urls: string[] = [];
  let first: Server;

  beforeAll(async () => {
    config.REDIS_URL = process.env.TEST_REDIS_URL;
    const app = await getApp();
    for (let i = 0; i < 2; i++) {
      const server = http.createServer(app);
      // Each server stands in for an API instance; the module keeps the last one.
      const io = attachLiveSockets(server);
      if (i === 0) first = io;
      urls.push(await listen(server));
    }
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await new Promise<void>((resolve) => first.close(() => resolve()));
    await closeLiveSockets();
    const redis = createClient({ url: process.env.TEST_REDIS_URL });
    await redis.connect();
    const keys = await redis.keys(`live:room:${tenant.id}:*`);
    if (keys.length) await redis.del(keys);
    await redis.close();
    await closeRedis();
    config.REDIS_URL = undefined;
  });

  it('shares presence, signalling and room state, and drops sockets on any instance', async () => {
    const [a, b] = urls;
    const t = sock(a, teacher.token);
    const s = sock(b, student.token);
    await Promise.all([connected(t), connected(s)]);
    expect((await emit(t, C.join, { sessionId: liveId })).ok).toBe(true);
    const joinedSeen = next<LiveUserRef>(t, S.participantJoined);
    const sJoin = await emit(s, C.join, { sessionId: liveId });
    expect(sJoin.data).toMatchObject({ hostOnline: true, me: { id: student.userId, role: 'student' } });
    expect((await joinedSeen).id).toBe(student.userId);

    const handsSeen = next<LiveUserRef[]>(t, S.handsUpdate);
    expect((await emit(s, C.handRaise)).ok).toBe(true);
    expect(ids(await handsSeen)).toEqual([student.userId]);
    // The teacher's instance finds the student's socket on the other one.
    const speakersSeen = next<LiveUserRef[]>(s, S.speakersUpdate);
    expect((await emit(t, C.micGrant, { userId: student.userId })).ok).toBe(true);
    expect(ids(await speakersSeen)).toEqual([student.userId]);

    const signalSeen = next<{ from: number }>(t, S.rtcSignal);
    expect((await emit(s, C.rtcSignal, { to: teacher.userId, candidate: { c: 1 } })).ok).toBe(true);
    expect((await signalSeen).from).toBe(student.userId);

    // State written on the teacher's instance, read by a socket joining on the other.
    const stroke = { id: 'ls-1', tool: 'pen', color: '#000000', width: 2, points: [0, 0, 0.5, 0.5] };
    expect((await emit(t, C.wbStroke, stroke)).ok).toBe(true);
    expect((await emit(t, C.screenState, { sharing: true })).ok).toBe(true);
    const s2 = sock(b, student.token);
    await connected(s2);
    const snapshot = (await emit(s2, C.join, { sessionId: liveId })).data;
    expect(snapshot).toMatchObject({ screenSharing: true, hostOnline: true });
    expect(ids(snapshot.speakers)).toEqual([student.userId]);
    expect(snapshot.whiteboard.strokes).toEqual([stroke]);

    // The host leaving on one instance reaches the class on the other.
    const hostLeft = next(s, S.hostState);
    t.disconnect();
    expect(await hostLeft).toEqual({ online: false });

    // A revoked device's socket is dropped from any instance; so are an institute's on suspension.
    const t2 = sock(a, teacher.token);
    await connected(t2);
    const revoked = dropped(t2);
    disconnectDeviceSockets((await deviceOf(teacher)).id);
    expect(await revoked).toBe('io server disconnect');

    const t3 = sock(a, teacher.token);
    await connected(t3);
    const gone = [t3, s, s2].map(dropped);
    await setSuspended(true);
    try {
      expect(await Promise.all(gone)).toEqual(Array(3).fill('io server disconnect'));
    } finally {
      await setSuspended(false);
    }
  });
});
