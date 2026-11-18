import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSTITUTE_IDLE_TIMEOUT_SETTING, SYSTEM_ROLES, type SystemRoleSlug } from '@erp/shared';
import { Branch } from '../src/modules/branches/branch.model';
import { Institute } from '../src/modules/institutes/institute.model';
import { User } from '../src/modules/users/user.model';
import { UserRole } from '../src/modules/permissions/models';
import { getSystemRole } from '../src/modules/permissions/catalog.service';
import { Plan, Subscription } from '../src/modules/subscriptions/models';
import { Device } from '../src/modules/authentication/models';
import { Course } from '../src/modules/academics/models';
import { LmsOfflineLicense, LmsResource } from '../src/modules/lms/models';
import { NotificationMessage, PushToken } from '../src/modules/notifications/models';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { USERS, bearer, getApp, login, newDevice, purgeRows, stableDevice } from './helpers';

type Device_ = ReturnType<typeof stableDevice>;
const device = (platform: 'web' | 'android' | 'ios') => newDevice(platform) as unknown as Device_;
const PASSWORD = 'Mobile@12345';
const tag = crypto.randomBytes(3).toString('hex');
let mobileSeq = Math.floor(Math.random() * 9_000_000);
const nextMobile = () => `943${String(++mobileSeq % 10_000_000).padStart(7, '0')}`;

describe('mobile & device security (spec 4.18)', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let instituteId: number;
  let branchA: number;
  let branchB: number;
  const userIds: number[] = [];
  const u: Record<string, { id: number; mobile: string; password: string }> = {};
  const fixtures: { courseId?: number; resourceId?: number } = {};

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, token: string) =>
    request(app)[method](`/api${url}`).set(bearer(token));

  async function createUser(
    key: string,
    opts: { role?: SystemRoleSlug; branchId?: number | null; superAdmin?: boolean },
  ) {
    const mobile = nextMobile();
    const user = await User.create({
      name: `MobSec ${tag} ${key}`,
      mobile,
      email: null,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      lastLoginAt: null,
      isSuperAdmin: !!opts.superAdmin,
    });
    userIds.push(user.id);
    if (opts.role) {
      const role = await getSystemRole(opts.role);
      await UserRole.create({
        userId: user.id,
        roleId: role.id,
        instituteId,
        branchId: opts.branchId ?? null,
      });
    }
    u[key] = { id: user.id, mobile, password: PASSWORD };
    return u[key];
  }

  const deviceOf = (d: Device_) => Device.findOne({ where: { deviceUid: d.uid } });
  const sessions: Record<string, Awaited<ReturnType<typeof login>>> = {};
  /** One long-lived session per actor (each new device costs an OTP and counts towards the limit). */
  async function session(key: string, platform: 'web' | 'android' | 'ios' = 'web') {
    sessions[key] ??= await login(u[key], device(platform));
    return sessions[key];
  }
  const licence = (id: number) => LmsOfflineLicense.findOne({ where: { id, instituteId } });

  beforeAll(async () => {
    app = await getApp();
    const inst = await Institute.create({
      name: `MobSec ${tag}`,
      slug: `mobsec-${tag}`,
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
    await Subscription.create({
      instituteId,
      planId: plan.id,
      status: 'active',
      billingCycle: 'monthly',
      startsAt: new Date(),
      endsAt: null,
      limitOverrides: null,
    });
    await createUser('admin', { role: SYSTEM_ROLES.INSTITUTE_ADMIN });
    await createUser('branchAdmin', { role: SYSTEM_ROLES.BRANCH_ADMIN, branchId: branchA });
    await createUser('student', { role: SYSTEM_ROLES.STUDENT, branchId: branchA });
    await createUser('teacher', { role: SYSTEM_ROLES.TEACHER, branchId: branchB });
    await createUser('bio', { role: SYSTEM_ROLES.STUDENT, branchId: branchA });
    await createUser('idle', { role: SYSTEM_ROLES.STUDENT, branchId: branchA });
    await createUser('capture', { role: SYSTEM_ROLES.STUDENT, branchId: branchA });
    await createUser('platform', { superAdmin: true });

    const course = await Course.create({
      instituteId,
      name: `MobSec ${tag}`,
      code: `MS-${tag}`,
      categoryId: null,
      templateId: null,
      description: null,
      durationValue: null,
      durationUnit: null,
    });
    const resource = await LmsResource.create({
      instituteId,
      branchId: null,
      courseId: course.id,
      subjectId: null,
      chapterId: null,
      topicId: null,
      title: 'Offline lecture',
      description: null,
      type: 'video',
      status: 'published',
      fileId: null,
      externalUrl: null,
      durationSeconds: 60,
      accessDays: null,
      availableFrom: null,
      availableUntil: null,
      offlineAllowed: true,
      createdByUserId: null,
    });
    Object.assign(fixtures, { courseId: course.id, resourceId: resource.id });
  });

  afterAll(async () => {
    await processDueJobs(200);
    await purgeRows('institutes', [instituteId]);
    await purgeRows('users', userIds);
  });

  it('lets an institute admin revoke a member device: immediate, audited, notified, offline wiped', async () => {
    const admin = await session('admin');
    const phone = device('android');
    const laptop = device('web');
    const onPhone = await login(u.student, phone);
    const onLaptop = await login(u.student, laptop);
    const phoneRow = (await deviceOf(phone))!;
    const laptopRow = (await deviceOf(laptop))!;
    const push = (d: Device_, platform: 'android' | 'web') =>
      PushToken.create({
        instituteId,
        userId: u.student.id,
        token: `tok-${d.uid}`,
        tokenHash: crypto.createHash('sha256').update(`tok-${d.uid}`).digest('hex'),
        platform,
        deviceUid: d.uid,
      });
    await push(phone, 'android');
    await push(laptop, 'web');
    const grant = (deviceId: number) =>
      LmsOfflineLicense.create({
        instituteId,
        resourceId: fixtures.resourceId!,
        userId: u.student.id,
        deviceId,
        contentKey: 'encrypted-key',
        expiresAt: new Date(Date.now() + 72 * 3600_000),
      });
    const phoneLicence = await grant(phoneRow.id);
    const otherLicence = await grant(laptopRow.id);

    const listed = await api('get', `/users/${u.student.id}/devices`, admin.accessToken);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(2);
    expect(listed.body[0]).toMatchObject({ status: 'active', biometricUnlock: false, revokedAt: null });
    expect(listed.body[0].createdAt).toEqual(expect.any(String));

    const revoked = await api('delete', `/users/${u.student.id}/devices/${phoneRow.id}`, admin.accessToken);
    expect(revoked.status).toBe(204);

    // Tokens stop working at once: the access token on the next request, the refresh token too.
    const me = await api('get', '/auth/me', onPhone.accessToken);
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
    // The (now revoked) refresh token reports the revocation too, so an app whose access token expired still wipes.
    const refresh = await request(app).post('/api/auth/refresh').send({ refreshToken: onPhone.refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe('SESSION_REVOKED');
    expect((await api('get', '/auth/me', onLaptop.accessToken)).status).toBe(200);

    const audit = await AuditEvent.findOne({
      where: { action: 'device.revoked', entityId: String(phoneRow.id) },
    });
    expect(audit).toMatchObject({ instituteId, actorUserId: u.admin.id });
    expect(audit!.metadata).toMatchObject({ userId: u.student.id, byAdmin: true });

    await processDueJobs(200);
    expect((await licence(phoneLicence.id))!.revokedAt).not.toBeNull();
    expect((await licence(otherLicence.id))!.revokedAt).toBeNull();
    const tokens = await PushToken.findAll({ where: { instituteId, userId: u.student.id } });
    expect(tokens.map((t) => t.deviceUid)).toEqual([laptop.uid]);
    const notice = await NotificationMessage.findOne({
      where: { instituteId, userId: u.student.id, eventKey: 'auth.device-revoked', channel: 'in_app' },
    });
    expect(notice?.body).toContain('Offline downloads');
    expect(notice?.body).toContain('Android');

    const after = await api('get', `/users/${u.student.id}/devices`, admin.accessToken);
    expect(after.body.find((d: { id: number }) => d.id === phoneRow.id)).toMatchObject({ status: 'revoked' });
    // idempotent
    expect(
      (await api('delete', `/users/${u.student.id}/devices/${phoneRow.id}`, admin.accessToken)).status,
    ).toBe(204);
    // the user revoking their own device gets no administrator notice
    await api('delete', `/auth/devices/${laptopRow.id}`, onLaptop.accessToken).expect(204);
    await processDueJobs(200);
    expect(
      await NotificationMessage.count({
        where: { instituteId, userId: u.student.id, eventKey: 'auth.device-revoked', channel: 'in_app' },
      }),
    ).toBe(1);
  });

  it('limits branch admins to members of their branches and hides other tenants', async () => {
    const branchAdmin = await session('branchAdmin');
    const admin = await session('admin');
    const teacher = await session('teacher', 'android');
    const student = await login(u.student, device('web'));

    expect((await api('get', `/users/${u.student.id}/devices`, branchAdmin.accessToken)).status).toBe(200);
    expect((await api('get', `/users/${u.teacher.id}/devices`, branchAdmin.accessToken)).status).toBe(404);
    expect((await api('get', `/users/${u.admin.id}/devices`, branchAdmin.accessToken)).status).toBe(404);
    const teacherDevice = (await deviceOf(teacher.device))!;
    expect(
      (await api('delete', `/users/${u.teacher.id}/devices/${teacherDevice.id}`, branchAdmin.accessToken))
        .status,
    ).toBe(404);
    expect((await api('get', '/auth/me', teacher.accessToken)).status).toBe(200);

    const search = await api(
      'get',
      `/users/devices?search=${encodeURIComponent(`MobSec ${tag}`)}`,
      branchAdmin.accessToken,
    );
    expect(search.status).toBe(200);
    const names = search.body.map((r: { id: number }) => r.id);
    expect(names).toEqual(expect.arrayContaining([u.student.id, u.bio.id, u.branchAdmin.id]));
    expect(names).not.toContain(u.teacher.id);
    expect(names).not.toContain(u.admin.id);
    expect(names).not.toContain(u.platform.id);

    const all = await api(
      'get',
      `/users/devices?search=${encodeURIComponent(`MobSec ${tag}`)}`,
      admin.accessToken,
    );
    expect(all.body.map((r: { id: number }) => r.id)).toEqual(
      expect.arrayContaining([u.student.id, u.teacher.id, u.admin.id]),
    );
    expect(all.body.find((r: { id: number }) => r.id === u.teacher.id)).toMatchObject({ activeDevices: 1 });

    // another institute's member is invisible; learners cannot manage devices
    const apexAdmin = (await User.findOne({ where: { mobile: USERS.apexAdmin.mobile } }))!;
    expect((await api('get', `/users/${apexAdmin.id}/devices`, admin.accessToken)).status).toBe(404);
    expect((await api('get', `/users/${u.bio.id}/devices`, student.accessToken)).status).toBe(403);
  });

  it('lets the super admin find any user and revoke their devices', async () => {
    const platform = await session('platform');
    const admin = await session('admin');
    const teacher = await session('teacher', 'android');
    const teacherDevice = (await deviceOf(teacher.device))!;

    expect((await api('get', '/admin/users?search=ab', platform.accessToken)).status).toBe(422);
    expect((await api('get', `/admin/users?search=${u.teacher.mobile}`, admin.accessToken)).status).toBe(403);
    const found = await api('get', `/admin/users?search=${u.teacher.mobile}`, platform.accessToken);
    expect(found.status).toBe(200);
    expect(found.body).toEqual([
      expect.objectContaining({
        id: u.teacher.id,
        isSuperAdmin: false,
        institutes: [{ id: instituteId, name: `MobSec ${tag}` }],
      }),
    ]);
    expect(found.body[0].activeDevices).toBeGreaterThanOrEqual(1);

    const devices = await api('get', `/admin/users/${u.teacher.id}/devices`, platform.accessToken);
    expect(devices.body.map((d: { id: number }) => d.id)).toContain(teacherDevice.id);
    expect((await api('get', '/admin/users/999999999/devices', platform.accessToken)).status).toBe(404);
    expect(
      (await api('delete', `/admin/users/${u.teacher.id}/devices/${teacherDevice.id}`, platform.accessToken))
        .status,
    ).toBe(204);
    expect((await api('get', '/auth/me', teacher.accessToken)).status).toBe(401);
    // a device of someone else cannot be revoked through another user's id
    const adminDevice = (await deviceOf(admin.device))!;
    expect(
      (await api('delete', `/admin/users/${u.teacher.id}/devices/${adminDevice.id}`, platform.accessToken))
        .status,
    ).toBe(404);
    await processDueJobs(200);
    expect(
      await NotificationMessage.count({
        where: { instituteId, userId: u.teacher.id, eventKey: 'auth.device-revoked', channel: 'in_app' },
      }),
    ).toBe(1);
  });

  it('ends only the impersonation when the impersonated account is deactivated', async () => {
    const platform = await session('platform');
    const target = await createUser('impTarget', { role: SYSTEM_ROLES.INSTITUTE_ADMIN });
    const impersonate = (body: object) =>
      api('post', '/auth/impersonate', platform.accessToken).send({ instituteId, reason: 'mobsec', ...body });
    const meOf = (token: string) => api('get', '/auth/me', token);

    const imp = await impersonate({ userId: target.id });
    expect(imp.status).toBe(200);
    expect((await meOf(imp.body.accessToken)).body.user.id).toBe(target.id);
    await User.update({ status: 'inactive' }, { where: { id: target.id } });
    const ended = await meOf(imp.body.accessToken);
    expect(ended.status).toBe(401);
    expect(ended.body.error.code).toBe('IMPERSONATION_ENDED');
    expect((await meOf(platform.accessToken)).status).toBe(200);
    expect((await impersonate({ userId: target.id })).status).toBe(400);

    // without a user, the first active institute admin is picked
    await User.update({ status: 'active' }, { where: { id: target.id } });
    await User.update({ status: 'inactive' }, { where: { id: u.admin.id } });
    try {
      const picked = await impersonate({});
      expect(picked.status).toBe(200);
      expect((await meOf(picked.body.accessToken)).body.user.id).toBe(target.id);
    } finally {
      await User.update({ status: 'active' }, { where: { id: u.admin.id } });
    }
  });

  it('enrols, uses and disables biometric unlock on app devices only', async () => {
    const web = await login(u.bio, device('web'));
    const ios = device('ios');
    const app1 = await login(u.bio, ios);
    const iosRow = (await deviceOf(ios))!;

    const onWeb = await api('post', '/auth/biometric', web.accessToken);
    expect(onWeb.status).toBe(403);
    expect(onWeb.body.error.code).toBe('BIOMETRIC_APP_ONLY');
    const enrolled = await api('post', '/auth/biometric', app1.accessToken);
    expect(enrolled.status).toBe(201);
    expect(enrolled.body).toMatchObject({ deviceId: iosRow.id, secret: expect.any(String) });
    const { secret } = enrolled.body as { secret: string };
    expect((await iosRow.reload()).unlockKeyHash).not.toContain(secret);
    expect((await api('get', '/auth/me', app1.accessToken)).body.session).toMatchObject({
      biometricUnlock: true,
    });

    const unlock = (body: Record<string, unknown>) =>
      request(app)
        .post('/api/auth/biometric/unlock')
        .send({ deviceId: iosRow.id, deviceUid: ios.uid, secret, ...body });
    const wrong = await unlock({ secret: `${secret}x` });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('BIOMETRIC_INVALID');
    expect((await unlock({ deviceUid: `${ios.uid}-other` })).body.error.code).toBe('BIOMETRIC_INVALID');

    const ok = await unlock({ instituteId });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'authenticated', accessToken: expect.any(String) });
    const me = await api('get', '/auth/me', ok.body.accessToken);
    expect(me.status).toBe(200);
    expect(me.body.institute.id).toBe(instituteId);
    // the session from before the lock is replaced
    expect(
      (await request(app).post('/api/auth/refresh').send({ refreshToken: app1.refreshToken })).status,
    ).toBe(401);
    expect(
      await AuditEvent.count({ where: { action: 'auth.login', entityId: String(u.bio.id) } }),
    ).toBeGreaterThanOrEqual(1);

    // turning it off (or signing out) invalidates the secret
    expect((await api('delete', '/auth/biometric', ok.body.accessToken)).status).toBe(204);
    expect((await unlock({})).body.error.code).toBe('BIOMETRIC_INVALID');
    const again = await api('post', '/auth/biometric', ok.body.accessToken);
    await request(app).post('/api/auth/logout').send({ refreshToken: ok.body.refreshToken }).expect(204);
    expect((await unlock({ secret: again.body.secret })).body.error.code).toBe('BIOMETRIC_INVALID');

    // revoking the device disables it for good
    const relogged = await login(u.bio, ios);
    const third = await api('post', '/auth/biometric', relogged.accessToken);
    const admin = await session('admin');
    await api('delete', `/users/${u.bio.id}/devices/${iosRow.id}`, admin.accessToken).expect(204);
    const afterRevoke = await unlock({ secret: third.body.secret });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.error.code).toBe('SESSION_REVOKED');
    expect((await iosRow.reload()).unlockKeyHash).toBeNull();
  });

  it('audits screenshots and recordings of protected screens reported by the app', async () => {
    const s = await login(u.capture, device('ios'));
    const row = (await deviceOf(s.device))!;
    const send = (body: object) => api('post', '/auth/capture-events', s.accessToken).send(body);
    expect((await send({ kind: 'screenshot', screens: ['Exam attempt'] })).status).toBe(422);
    expect((await send({ kind: 'photo', screens: [] })).status).toBe(422);
    await send({ kind: 'screenshot', screens: ['exam-attempt', 'exam-attempt'] }).expect(204);
    await send({ kind: 'recording', screens: ['lms-content'] }).expect(204);
    const events = await AuditEvent.findAll({
      where: {
        entityType: 'device',
        entityId: String(row.id),
        action: ['device.screenshot_detected', 'device.recording_detected'],
      },
      order: [['id', 'ASC']],
    });
    expect(events.map((e) => [e.action, e.metadata, e.actorUserId, e.instituteId])).toEqual([
      ['device.screenshot_detected', { screens: ['exam-attempt'] }, u.capture.id, instituteId],
      ['device.recording_detected', { screens: ['lms-content'] }, u.capture.id, instituteId],
    ]);
    expect(
      (await request(app).post('/api/auth/capture-events').send({ kind: 'screenshot', screens: [] })).status,
    ).toBe(401);
  });

  it('expires idle sessions on the server using the institute setting', async () => {
    const admin = await session('admin');
    const idle = await login(u.idle, device('web'));
    const row = (await deviceOf(idle.device))!;
    const backdate = (minutes: number) =>
      Device.update({ lastSeenAt: new Date(Date.now() - minutes * 60_000) }, { where: { id: row.id } });

    expect((await api('patch', '/institute', admin.accessToken).send({ idleTimeoutMinutes: 3 })).status).toBe(
      422,
    );
    const saved = await api('patch', '/institute', admin.accessToken).send({ idleTimeoutMinutes: 15 });
    expect(saved.status).toBe(200);
    expect(saved.body.idleTimeoutMinutes).toBe(15);
    expect((await api('get', '/institute', admin.accessToken)).body.idleTimeoutMinutes).toBe(15);
    expect((await api('get', '/auth/me', idle.accessToken)).body.session).toEqual({
      idleTimeoutMinutes: 15,
      biometricUnlock: false,
    });

    // background polls do not count as activity; the heartbeat does
    await backdate(10);
    await api('get', '/auth/me', idle.accessToken).set('X-Background-Request', '1').expect(200);
    const before = (await row.reload()).lastSeenAt!.getTime();
    expect(Date.now() - before).toBeGreaterThan(9 * 60_000);
    await api('post', '/auth/activity', idle.accessToken).expect(204);
    expect(Date.now() - (await row.reload()).lastSeenAt!.getTime()).toBeLessThan(60_000);

    await backdate(16);
    const expired = await api('get', '/auth/me', idle.accessToken);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('SESSION_IDLE');
    const refresh = await request(app).post('/api/auth/refresh').send({ refreshToken: idle.refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe('SESSION_IDLE');
    // the device itself stays registered: signing in again works without OTP
    await backdate(0);
    expect(
      (await request(app).post('/api/auth/refresh').send({ refreshToken: idle.refreshToken })).status,
    ).toBe(401);
    const back = await login(u.idle, idle.device);
    expect((await api('get', '/auth/me', back.accessToken)).status).toBe(200);
    expect((await row.reload()).status).toBe('active');

    const put = (value: unknown) =>
      api('put', `/institute/settings/${INSTITUTE_IDLE_TIMEOUT_SETTING}`, admin.accessToken).send({ value });
    expect((await put(7.5)).status).toBe(422);
    expect((await put(0)).status).toBe(200);
    await backdate(600);
    expect((await api('get', '/auth/me', back.accessToken)).status).toBe(200);
  });
});
