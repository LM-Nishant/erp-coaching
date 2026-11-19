import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INSTITUTE_IDLE_TIMEOUT_SETTING,
  LIVE_SOCKET_NAMESPACE,
  LIVE_SOCKET_PATH,
  SYSTEM_ROLES,
  type SystemRoleSlug,
} from '@erp/shared';
import { Branch } from '../src/modules/branches/branch.model';
import { Institute } from '../src/modules/institutes/institute.model';
import { InstituteSetting } from '../src/modules/institutes/institute-setting.model';
import { User } from '../src/modules/users/user.model';
import { UserBranch, UserRole } from '../src/modules/permissions/models';
import { getSystemRole } from '../src/modules/permissions/catalog.service';
import { Plan, Subscription } from '../src/modules/subscriptions/models';
import { getAccessState, invalidateAccess } from '../src/modules/subscriptions/api';
import { Device } from '../src/modules/authentication/models';
import { attachLiveSockets, closeLiveSockets } from '../src/modules/live-classes/realtime';
import { clearIdleTimeoutCache } from '../src/shared/session-policy';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { bearer, getApp, login, newDevice, purgeRows, stableDevice } from './helpers';

type Device_ = ReturnType<typeof stableDevice>;
const PASSWORD = 'Guards@12345';
const DAY = 86_400_000;
const tag = crypto.randomBytes(3).toString('hex');
let mobileSeq = Math.floor(Math.random() * 9_000_000);
const nextMobile = () => `947${String(++mobileSeq % 10_000_000).padStart(7, '0')}`;

/**
 * Session checks (#17: revoked / idle devices) combined with the subscription guard (#16), for REST and the
 * live-class socket handshake, and the branch rule (#20) for member device management.
 */
describe('device session checks, subscription guard and member devices', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let server: http.Server;
  let baseUrl: string;
  let instituteId: number;
  let branchA: number;
  let branchB: number;
  let subscription: Subscription;
  const userIds: number[] = [];
  const sockets: Socket[] = [];
  const u: Record<string, { id: number; mobile: string; password: string }> = {};
  let passwordHash: string;

  async function createUser(key: string, roles: { role: SystemRoleSlug; branchId: number | null }[]) {
    const mobile = nextMobile();
    const user = await User.create({
      name: `Guards ${tag} ${key}`,
      mobile,
      email: null,
      passwordHash,
      lastLoginAt: null,
    });
    userIds.push(user.id);
    for (const r of roles)
      await UserRole.create({
        userId: user.id,
        roleId: (await getSystemRole(r.role)).id,
        instituteId,
        branchId: r.branchId,
      });
    u[key] = { id: user.id, mobile, password: PASSWORD };
    return u[key];
  }

  const signIn = (key: string) => login(u[key], newDevice('web') as unknown as Device_);
  const deviceOf = async (d: Device_) => (await Device.findOne({ where: { deviceUid: d.uid } }))!;
  const api = (method: 'get' | 'post' | 'patch' | 'delete', url: string, token: string) =>
    request(app)[method](`/api${url}`).set(bearer(token));

  /** Connects to the live-class namespace: resolves once connected, or with the handshake's error code. */
  function handshake(token: string) {
    const socket = connect(`${baseUrl}${LIVE_SOCKET_NAMESPACE}`, {
      path: LIVE_SOCKET_PATH,
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return new Promise<{ socket: Socket; error?: { code: string; status: number } }>((resolve) => {
      socket.once('connect', () => resolve({ socket }));
      socket.once('connect_error', (e: Error & { data?: { code: string; status: number } }) =>
        resolve({ socket, error: e.data }),
      );
    });
  }

  async function setSubscription(values: { suspendedAt?: Date | null; endsAt?: Date | null }) {
    await Subscription.update(values, { where: { id: subscription.id, instituteId } });
    invalidateAccess(instituteId);
  }

  beforeAll(async () => {
    app = await getApp();
    passwordHash = await bcrypt.hash(PASSWORD, 4);
    const inst = await Institute.create({
      name: `Guards ${tag}`,
      slug: `guards-${tag}`,
      logoFileId: null,
      primaryColor: null,
      secondaryColor: null,
      address: null,
      city: null,
      state: null,
      registrationNumber: null,
      gstin: null,
      contactEmail: null,
      contactPhone: null,
      bankDetails: null,
    });
    instituteId = inst.id;
    const branch = (name: string, code: string) =>
      Branch.create({ instituteId, name, code, address: null, city: null, phone: null, email: null });
    branchA = (await branch('North', 'N')).id;
    branchB = (await branch('South', 'S')).id;
    const plan = (await Plan.findOne({ where: { code: 'growth' } }))!;
    subscription = await Subscription.create({
      instituteId,
      planId: plan.id,
      status: 'active',
      billingCycle: 'monthly',
      startsAt: new Date(),
      endsAt: null,
      limitOverrides: null,
    });

    await createUser('admin', [{ role: SYSTEM_ROLES.INSTITUTE_ADMIN, branchId: null }]);
    await createUser('branchAdmin', [{ role: SYSTEM_ROLES.BRANCH_ADMIN, branchId: branchA }]);
    await createUser('student', [{ role: SYSTEM_ROLES.STUDENT, branchId: branchA }]);
    // Two roles in branch A: one search result, manageable by the branch admin.
    await createUser('twoRoles', [
      { role: SYSTEM_ROLES.STUDENT, branchId: branchA },
      { role: SYSTEM_ROLES.TEACHER, branchId: branchA },
    ]);
    // Shares branch A but also has branch B: visible to the branch admin, not theirs to manage.
    await createUser('straddler', [{ role: SYSTEM_ROLES.TEACHER, branchId: branchA }]);
    await UserBranch.create({ userId: u.straddler.id, instituteId, branchId: branchB });
    await createUser('teacherB', [{ role: SYSTEM_ROLES.TEACHER, branchId: branchB }]);
    // At most two active devices per user (MAX_ACTIVE_DEVICES), so the session checks use three accounts.
    await createUser('sessions', [{ role: SYSTEM_ROLES.INSTITUTE_ADMIN, branchId: null }]);
    await createUser('idler', [{ role: SYSTEM_ROLES.STUDENT, branchId: branchA }]);
    await createUser('loser', [{ role: SYSTEM_ROLES.STUDENT, branchId: branchA }]);

    server = http.createServer(app);
    attachLiveSockets(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await closeLiveSockets();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await processDueJobs(200);
    clearIdleTimeoutCache(instituteId);
    invalidateAccess(instituteId);
    await purgeRows('institutes', [instituteId]);
    await purgeRows('users', userIds);
  });

  it('answers 401 for revoked or idle devices before the subscription 402, for REST and live-class sockets', async () => {
    const active = await signIn('sessions');
    const live = await handshake(active.accessToken);
    expect(live.error).toBeUndefined();

    // Read-only: reads and the socket handshake (a read) work, writes get 402.
    await setSubscription({ endsAt: new Date(Date.now() - 8 * DAY) });
    expect((await getAccessState(instituteId)).state).toBe('restricted');
    expect((await api('get', '/branches', active.accessToken)).status).toBe(200);
    const write = await api('patch', `/branches/${branchA}`, active.accessToken).send({ name: 'North' });
    expect(write.status).toBe(402);
    expect(write.body.error.code).toBe('SUBSCRIPTION_RESTRICTED');
    expect((await handshake(active.accessToken)).error).toBeUndefined();

    // Suspended: only /auth, /subscription and /tenant-data; the socket is refused with the same code.
    await setSubscription({ suspendedAt: new Date() });
    expect((await getAccessState(instituteId)).state).toBe('suspended');
    const blocked = await api('get', '/branches', active.accessToken);
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect((await api('get', '/auth/me', active.accessToken)).status).toBe(200);
    expect((await handshake(active.accessToken)).error).toEqual({
      code: 'SUBSCRIPTION_SUSPENDED',
      status: 402,
    });

    // Idle while suspended: 401 SESSION_IDLE, not 402, so the app locks or signs out.
    const idle = await signIn('idler');
    await InstituteSetting.create({ instituteId, key: INSTITUTE_IDLE_TIMEOUT_SETTING, value: 15 });
    clearIdleTimeoutCache(instituteId);
    try {
      await Device.update(
        { lastSeenAt: new Date(Date.now() - 20 * 60_000) },
        { where: { id: (await deviceOf(idle.device)).id } },
      );
      const idleRest = await api('get', '/branches', idle.accessToken);
      expect([idleRest.status, idleRest.body.error.code]).toEqual([401, 'SESSION_IDLE']);
      expect((await handshake(idle.accessToken)).error).toEqual({ code: 'SESSION_IDLE', status: 401 });
    } finally {
      await InstituteSetting.destroy({ where: { instituteId, key: INSTITUTE_IDLE_TIMEOUT_SETTING } });
      clearIdleTimeoutCache(instituteId);
    }

    // Revoked while suspended (the user signs a lost device out from My devices: /auth stays reachable).
    const lost = await signIn('loser');
    const kept = await signIn('loser');
    await api('delete', `/auth/devices/${(await deviceOf(lost.device)).id}`, kept.accessToken).expect(204);
    const revokedRest = await api('get', '/branches', lost.accessToken);
    expect([revokedRest.status, revokedRest.body.error.code]).toEqual([401, 'SESSION_REVOKED']);
    expect((await handshake(lost.accessToken)).error).toEqual({ code: 'SESSION_REVOKED', status: 401 });

    // Back to active: the revoked device's open live-class socket is dropped once the revocation is processed.
    await setSubscription({ suspendedAt: null, endsAt: null });
    const other = await signIn('sessions');
    const open = await handshake(active.accessToken);
    expect(open.error).toBeUndefined();
    const dropped = new Promise<string>((resolve) => open.socket.once('disconnect', resolve));
    await api('delete', `/auth/devices/${(await deviceOf(active.device)).id}`, other.accessToken).expect(204);
    await processDueJobs(200);
    expect(await dropped).toBe('io server disconnect');
    expect(live.socket.connected).toBe(false);
  });

  it("limits a branch admin's member-device search and device APIs to members wholly within their branches", async () => {
    const branchAdmin = await signIn('branchAdmin');
    const admin = await signIn('admin');
    const straddler = await signIn('straddler');
    const studentSession = await signIn('student');
    const straddlerDevice = await deviceOf(straddler.device);
    const studentDevice = await deviceOf(studentSession.device);
    const search = async (token: string) => {
      const res = await api('get', `/users/devices?search=${encodeURIComponent(`Guards ${tag}`)}`, token);
      expect(res.status).toBe(200);
      return (res.body as { id: number }[]).map((r) => r.id);
    };

    const scoped = await search(branchAdmin.accessToken);
    const inBranchA = ['branchAdmin', 'student', 'twoRoles', 'idler', 'loser'].map((k) => u[k].id);
    expect(scoped.sort((a, b) => a - b)).toEqual(inBranchA.sort((a, b) => a - b));
    const everyone = await search(admin.accessToken);
    expect(new Set(everyone).size).toBe(everyone.length);
    expect(everyone).toEqual(expect.arrayContaining(Object.values(u).map((x) => x.id)));

    // Visible (shares branch A) but not manageable: 403 for the device list and revocation.
    expect((await api('get', `/users/${u.straddler.id}`, branchAdmin.accessToken)).status).toBe(200);
    const list = await api('get', `/users/${u.straddler.id}/devices`, branchAdmin.accessToken);
    expect([list.status, list.body.error.code]).toEqual([403, 'BRANCH_FORBIDDEN']);
    const revoke = await api(
      'delete',
      `/users/${u.straddler.id}/devices/${straddlerDevice.id}`,
      branchAdmin.accessToken,
    );
    expect(revoke.status).toBe(403);
    expect((await api('get', '/auth/me', straddler.accessToken)).status).toBe(200);
    // Another branch only: invisible.
    expect((await api('get', `/users/${u.teacherB.id}/devices`, branchAdmin.accessToken)).status).toBe(404);
    // Wholly within branch A: listed and revocable.
    expect((await api('get', `/users/${u.student.id}/devices`, branchAdmin.accessToken)).status).toBe(200);
    await api('delete', `/users/${u.student.id}/devices/${studentDevice.id}`, branchAdmin.accessToken).expect(
      204,
    );
    expect((await api('get', '/auth/me', studentSession.accessToken)).body.error.code).toBe(
      'SESSION_REVOKED',
    );
  });

  it('caps the device search at 50 members, not 50 role rows', async () => {
    const admin = await signIn('admin');
    const [student, teacher] = await Promise.all([
      getSystemRole(SYSTEM_ROLES.STUDENT),
      getSystemRole(SYSTEM_ROLES.TEACHER),
    ]);
    const bulk = await User.bulkCreate(
      Array.from({ length: 30 }, (_, i) => ({
        name: `Bulk ${tag} ${String(i).padStart(2, '0')}`,
        mobile: nextMobile(),
        email: null,
        passwordHash,
        lastLoginAt: null,
      })),
    );
    userIds.push(...bulk.map((b) => b.id));
    await UserRole.bulkCreate(
      bulk.flatMap((b) => [
        { userId: b.id, roleId: student.id, instituteId, branchId: branchA },
        { userId: b.id, roleId: teacher.id, instituteId, branchId: branchA },
      ]),
    );
    const res = await api(
      'get',
      `/users/devices?search=${encodeURIComponent(`Bulk ${tag}`)}`,
      admin.accessToken,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(30);
  });

  it('scopes GET /users to members visible to a branch admin', async () => {
    const branchAdmin = await signIn('branchAdmin');
    const res = await api(
      'get',
      `/users?search=${encodeURIComponent(`Guards ${tag}`)}&limit=100`,
      branchAdmin.accessToken,
    );
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: number }[]).map((i) => i.id);
    // Branch A members plus institute-level staff; never a branch-B-only member.
    expect(ids).toEqual(
      expect.arrayContaining([u.branchAdmin.id, u.student.id, u.twoRoles.id, u.straddler.id, u.admin.id]),
    );
    expect(ids).not.toContain(u.teacherB.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lets admins sign out members' devices while the institute is suspended or read-only", async () => {
    await createUser('devicesAdmin', [{ role: SYSTEM_ROLES.INSTITUTE_ADMIN, branchId: null }]);
    await createUser('lostPhone', [{ role: SYSTEM_ROLES.STUDENT, branchId: branchA }]);
    const admin = await signIn('devicesAdmin');
    const signOutLostPhone = async () => {
      const lost = await signIn('lostPhone');
      const device = await deviceOf(lost.device);
      const search = `/users/devices?search=${encodeURIComponent(`Guards ${tag} lostPhone`)}`;
      const found = await api('get', search, admin.accessToken);
      expect([found.status, found.body.map((m: { id: number }) => m.id)]).toEqual([200, [u.lostPhone.id]]);
      const list = await api('get', `/users/${u.lostPhone.id}/devices`, admin.accessToken);
      expect(list.status).toBe(200);
      expect(list.body.map((d: { id: number }) => d.id)).toContain(device.id);
      await api('delete', `/users/${u.lostPhone.id}/devices/${device.id}`, admin.accessToken).expect(204);
      expect((await api('get', '/auth/me', lost.accessToken)).body.error.code).toBe('SESSION_REVOKED');
    };
    try {
      await setSubscription({ suspendedAt: new Date() });
      await signOutLostPhone();
      // The rest of /users stays blocked.
      const member = await api('get', `/users/${u.lostPhone.id}`, admin.accessToken);
      expect([member.status, member.body.error.code]).toEqual([402, 'SUBSCRIPTION_SUSPENDED']);

      await setSubscription({ suspendedAt: null, endsAt: new Date(Date.now() - 8 * DAY) });
      expect((await getAccessState(instituteId)).state).toBe('restricted');
      await signOutLostPhone();
      const removal = await api('delete', `/users/${u.lostPhone.id}`, admin.accessToken);
      expect([removal.status, removal.body.error.code]).toEqual([402, 'SUBSCRIPTION_RESTRICTED']);
    } finally {
      await setSubscription({ suspendedAt: null, endsAt: null });
    }
  });
});
