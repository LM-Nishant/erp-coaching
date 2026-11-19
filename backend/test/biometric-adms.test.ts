import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLAN_MODULE_KEYS,
  type AttendanceDeviceDto,
  type DeviceCommandDto,
  type DevicePinDto,
} from '@erp/shared';
import { config } from '../src/infrastructure/config';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { getActiveSubscription } from '../src/modules/subscriptions/subscription.service';
import { nowInZone, todayIn } from '../src/shared/timezone';
import { getApp } from './helpers';
import {
  createInstitute,
  createStaff,
  createSuperAdmin,
  marker,
  ok,
  PASSWORD,
  purgeInstitutes,
  query,
  send,
  type Actor,
  type Tenant,
} from './security/harness';

/**
 * ZKTeco/eSSL ADMS push (`/iclock/*`), driven at the HTTP boundary with recorded device requests
 * (test/fixtures/adms). Users have 955… mobiles (CONTRIBUTING.md › Tests); everything is purged.
 */

const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;
const Y = todayIn(TZ, new Date(Date.now() - DAY));
const TODAY = todayIn(TZ);
const STALE = todayIn(TZ, new Date(Date.now() - 40 * DAY));
const inTwoHours = nowInZone(TZ, new Date(Date.now() + 2 * 3_600_000));
const FUTURE = `${inTwoHours.date} ${inTwoHours.time}:00`;

let n = 0;
const mobile = () => `955${String(n++).padStart(7, '0')}`;
const utc = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

/** A recorded request body with its `{{VAR}}` placeholders filled in. */
function fixture(name: string, vars: Record<string, string | number> = {}): string {
  const text = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'adms', name), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  const left = /\{\{\w+\}\}/.exec(text);
  if (left) throw new Error(`Fixture ${name}: no value for ${left[0]}`);
  return text;
}

type Params = Record<string, string | number>;
interface IclockRequest {
  query?: Params;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

/** A device request: no token, text body (devices send `text/plain` or nothing useful). */
async function iclock(
  method: 'get' | 'post',
  url: string,
  opts: IclockRequest = {},
): Promise<request.Response> {
  let req = request(await getApp())[method](url);
  if (opts.query) req = req.query(opts.query);
  for (const [k, v] of Object.entries({ 'Content-Type': 'text/plain', ...opts.headers })) req = req.set(k, v);
  return opts.body === undefined ? await req : await req.send(opts.body);
}

const handshake = (
  sn?: string,
  opts: { path?: string; query?: Params; headers?: Record<string, string> } = {},
) =>
  iclock('get', opts.path ?? '/iclock/cdata', {
    query: { ...(sn === undefined ? {} : { SN: sn }), options: 'all', ...opts.query },
    headers: opts.headers,
  });

const push = (
  sn: string,
  table: string,
  body: string | Buffer,
  extra: Params = {},
  headers: Record<string, string> = {},
) => iclock('post', '/iclock/cdata', { query: { SN: sn, table, ...extra }, body, headers });

const poll = (sn: string, extra: Params = {}) =>
  iclock('get', '/iclock/getrequest', { query: { SN: sn, ...extra } });

/**
 * POSTs the headers and the first 64 KB of a `declaredBytes` body, and resolves with the response, which
 * must therefore arrive before the server could have read the body. The rest is never sent.
 */
async function partialUpload(url: string, declaredBytes: number): Promise<{ status: number; body: string }> {
  const server = http.createServer(await getApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: (server.address() as AddressInfo).port,
          method: 'POST',
          path: url,
          headers: { 'content-type': 'text/plain', 'content-length': declaredBytes },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body });
            req.destroy();
          });
        },
      );
      req.on('error', reject);
      req.write(Buffer.alloc(64 * 1024, 0x41));
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function deviceDto(who: Actor, id: number): Promise<AttendanceDeviceDto> {
  const list: AttendanceDeviceDto[] = await ok(who, 'GET', '/api/attendance/devices');
  const d = list.find((x) => x.id === id);
  if (!d) throw new Error(`Device ${id} is not listed`);
  return d;
}

interface DeviceEvent {
  id: number;
  deviceId: number;
  enrolmentId: string;
  punchedAt: string;
  direction: string | null;
  status: string;
  studentUserId: number | null;
  note: string | null;
}

async function events(who: Actor, deviceId: number): Promise<DeviceEvent[]> {
  const page = await ok(who, 'GET', '/api/attendance/device-events?pageSize=200');
  return (page.items as DeviceEvent[]).filter((e) => e.deviceId === deviceId);
}

const putPin = (who: Actor, pin: string, target: unknown) =>
  send(who, 'PUT', '/api/attendance/device-pins', { pin, target });

/** One-file ustar archive, as in `ContentType=tgz` data packets. */
function ustar(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`;
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii');
  header.write(octal(0, 8), 116, 'ascii');
  header.write(octal(data.length, 12), 124, 'ascii');
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]);
}

describe('ZKTeco/eSSL ADMS push (/iclock)', () => {
  const tag = marker('adms');
  const serial = (k: string) => `${tag}-${k}`.toUpperCase();
  let A: Tenant;
  let B: Tenant;
  let admin: Actor;
  let clerk: Actor;
  let clerk2: Actor;
  const ids = {} as Record<
    'branch2' | 'teacher' | 's1' | 's2' | 's3' | 'subject' | 'batch1' | 'batch2' | 'cls' | 'emp' | 'emp2',
    number
  >;
  const dev = {} as Record<'A' | 'B' | 'C' | 'api' | 'beta', AttendanceDeviceDto>;

  beforeAll(async () => {
    const superAdmin = await createSuperAdmin(mobile());
    A = await createInstitute(superAdmin, {
      slug: `${tag}-a`,
      name: `ADMS A ${tag}`,
      adminMobile: mobile(),
      label: 'admin A',
    });
    B = await createInstitute(superAdmin, {
      slug: `${tag}-b`,
      name: `ADMS B ${tag}`,
      adminMobile: mobile(),
      label: 'admin B',
    });
    admin = A.admin;
    const main = A.mainBranchId;
    const code = (prefix: string) => `${prefix}-${tag.slice(-6)}`.toUpperCase();
    ids.branch2 = (
      await ok(admin, 'POST', '/api/branches', { name: `${tag} Branch 2`, code: code('B2') })
    ).id;

    const [teacherRole] = await query<{ id: number }>(
      "SELECT id FROM roles WHERE slug = 'teacher' AND institute_id IS NULL",
    );
    const teacherMobile = mobile();
    await ok(admin, 'POST', '/api/users', {
      name: `${tag} Teacher`,
      mobile: teacherMobile,
      password: PASSWORD,
      roles: [{ roleId: teacherRole.id, branchId: main }],
      branchIds: [main],
    });
    ids.teacher = (
      await query<{ id: number }>('SELECT id FROM users WHERE mobile = ?', [teacherMobile])
    )[0].id;

    const student = async (name: string, branchId: number): Promise<number> =>
      (await ok(admin, 'POST', '/api/students', { name, mobile: mobile(), branchId })).userId;
    ids.s1 = await student('Asha ADMS', main);
    ids.s2 = await student('Bala ADMS', main);
    ids.s3 = await student('Charu ADMS', ids.branch2);

    const joinedOn = todayIn(TZ, new Date(Date.now() - 30 * DAY));
    const session = await ok(admin, 'POST', '/api/academics/sessions', {
      name: `ADMS ${tag}`,
      startDate: '2020-04-01',
      endDate: '2040-03-31',
    });
    ids.subject = (
      await ok(admin, 'POST', '/api/academics/subjects', { name: `ADMS Maths ${tag}`, code: code('AM') })
    ).id;
    const course = await ok(admin, 'POST', '/api/academics/courses', {
      name: `ADMS Course ${tag}`,
      code: code('AC'),
      subjectIds: [ids.subject],
      branchIds: [main, ids.branch2],
    });
    const batch = async (branchId: number, prefix: string, teacherUserId?: number): Promise<number> =>
      (
        await ok(admin, 'POST', '/api/academics/batches', {
          branchId,
          courseId: course.id,
          academicSessionId: session.id,
          name: `ADMS ${prefix}`,
          code: code(prefix),
          capacity: 30,
          startDate: joinedOn,
          ...(teacherUserId ? { teachers: [{ teacherUserId, subjectId: ids.subject }] } : {}),
        })
      ).id;
    ids.batch1 = await batch(main, 'BA', ids.teacher);
    ids.batch2 = await batch(ids.branch2, 'BB');
    await ok(admin, 'POST', `/api/academics/batches/${ids.batch1}/students`, {
      studentUserIds: [ids.s1, ids.s2],
      joinedOn,
    });
    await ok(admin, 'POST', `/api/academics/batches/${ids.batch2}/students`, {
      studentUserIds: [ids.s3],
      joinedOn,
    });
    ids.cls = (
      await ok(admin, 'POST', '/api/academics/class-sessions', {
        batchId: ids.batch1,
        subjectId: ids.subject,
        teacherUserId: ids.teacher,
        date: Y,
        startTime: '10:00',
        endTime: '11:00',
      })
    ).id;

    const employee = async (name: string, branchId: number, biometricEnrolmentId?: string): Promise<number> =>
      (
        await ok(admin, 'POST', '/api/hr/employees', {
          name,
          dateOfJoining: '2024-06-01',
          designation: 'Staff',
          branchId,
          ...(biometricEnrolmentId ? { biometricEnrolmentId } : {}),
        })
      ).id;
    ids.emp = await employee('Ravi Staff', main);
    ids.emp2 = await employee('Nila Two', ids.branch2, '8008');

    clerk = await createStaff(admin, {
      label: 'device clerk',
      mobile: mobile(),
      permissions: ['attendance.configure'],
      branchId: main,
    });
    clerk2 = await createStaff(admin, {
      label: 'device and HR clerk',
      mobile: mobile(),
      permissions: ['attendance.configure', 'hr.view', 'hr.edit'],
      branchId: main,
    });

    const device = (who: Actor, body: Record<string, unknown>): Promise<AttendanceDeviceDto> =>
      ok(who, 'POST', '/api/attendance/devices', body);
    dev.A = await device(admin, {
      name: 'Front gate',
      serial: serial('A'),
      branchId: main,
      protocol: 'adms',
      allowHttp: true,
    });
    dev.B = await device(admin, {
      name: 'Branch 2 gate',
      serial: serial('B'),
      branchId: ids.branch2,
      protocol: 'adms',
      allowHttp: true,
      timeZone: TZ,
    });
    dev.C = await device(admin, {
      name: 'Lab, clock on UTC',
      serial: serial('C'),
      branchId: main,
      protocol: 'adms',
      allowHttp: true,
      timeZone: 'UTC',
    });
    dev.api = await device(admin, { name: 'Middleware', serial: serial('API') });
    dev.beta = await device(B.admin, {
      name: 'Tenant B gate',
      serial: serial('BETA'),
      protocol: 'adms',
      allowHttp: true,
    });
  }, 120_000);

  afterAll(async () => {
    await purgeInstitutes([A?.id ?? 0, B?.id ?? 0], '955');
  });

  it('registers ADMS devices by serial number and refuses anything else', async () => {
    expect(dev.A).toMatchObject({
      protocol: 'adms',
      allowHttp: true,
      ipAllowlist: [],
      timeZone: null,
      lastSeenAt: null,
      lastError: null,
      info: null,
    });
    expect(dev.A.apiKey).toBeUndefined();
    expect(dev.api.protocol).toBe('api');
    expect(dev.api.apiKey).toEqual(expect.any(String));

    const create = (body: Record<string, unknown>) => send(admin, 'POST', '/api/attendance/devices', body);
    expect((await create({ name: 'X', serial: 'HAS SPACE', protocol: 'adms' })).status).toBe(400);
    for (const taken of [serial('A'), serial('BETA')]) {
      const res = await create({ name: 'X', serial: taken, protocol: 'adms' });
      expect(res.status, taken).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_SERIAL');
    }
    // ADMS settings on a punch API device; a bad IP rule or an unknown zone fails validation.
    expect((await create({ name: 'X', serial: serial('X'), allowHttp: true })).status).toBe(400);
    expect(
      (await create({ name: 'X', serial: serial('X'), protocol: 'adms', ipAllowlist: ['300.1.2.3'] })).status,
    ).toBe(422);
    expect(
      (await create({ name: 'X', serial: serial('X'), protocol: 'adms', timeZone: 'Mars/Base' })).status,
    ).toBe(422);
    expect((await send(admin, 'POST', `/api/attendance/devices/${dev.A.id}/rotate-key`)).status).toBe(400);

    // The generic punch API doesn't accept ADMS devices (they have no API key).
    const punch = await send(
      null,
      'POST',
      '/api/attendance/public/device-events',
      { punches: [] },
      { 'x-device-serial': serial('A'), 'x-device-key': 'guess' },
    );
    expect(punch.status).toBe(401);

    for (const sn of [undefined, 'UNKNOWN-955', 'HAS SPACE', serial('API')]) {
      const res = await handshake(sn);
      expect(res.status, String(sn)).toBe(403);
      expect(res.body.error.code).toBe('DEVICE_FORBIDDEN');
    }
    await ok(admin, 'PATCH', `/api/attendance/devices/${dev.A.id}`, { active: false });
    expect((await handshake(serial('A'))).status).toBe(403);
    await ok(admin, 'PATCH', `/api/attendance/devices/${dev.A.id}`, { active: true });

    // Unknown devices are refused before the body is read: the answer arrives while most of it is unsent.
    const big = await partialUpload('/iclock/cdata?SN=UNKNOWN-955&table=ATTLOG', 3 * 1024 * 1024);
    expect(big.status).toBe(403);
    expect(JSON.parse(big.body).error.code).toBe('DEVICE_FORBIDDEN');
  });

  it('answers the handshake with upload pointers and the clock offset', async () => {
    const res = await handshake(serial('A'), { query: { pushver: '2.4.1', language: '69' } });
    expect(res.status, res.text).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.split('\n')).toEqual([
      `GET OPTION FROM: ${serial('A')}`,
      'ATTLOGStamp=None',
      'OPERLOGStamp=9999',
      'ATTPHOTOStamp=None',
      'ErrorDelay=60',
      'Delay=30',
      'TransTimes=00:00;14:05',
      'TransInterval=1',
      'TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser',
      'TimeZone=330',
      'Realtime=1',
      'Encrypt=None',
      'ServerVer=2.2.14',
      'PushProtVer=2.2.14',
      'SupportPing=1',
    ]);

    // Paths and parameter names in any case, with the `.aspx` suffix some firmware adds.
    const c = await iclock('get', '/ICLOCK/CDATA.ASPX', { query: { sn: serial('C'), options: 'all' } });
    expect(c.status).toBe(200);
    expect(c.text).toContain(`GET OPTION FROM: ${serial('C')}`);
    expect(c.text).toContain('TimeZone=0');
    expect((await handshake(serial('B'), { path: '/iclock/cdata.aspx' })).text).toContain('TimeZone=330');

    const a = await deviceDto(admin, dev.A.id);
    expect(a.lastSeenAt).not.toBeNull();
    expect(a.lastIp).toBe('127.0.0.1');
    expect(a.info).toEqual({ pushVersion: '2.4.1' });
  });

  it('reads punches in device time, applies them and shows what was skipped', async () => {
    await ok(admin, 'PUT', '/api/attendance/device-pins', {
      pin: '1001',
      target: { type: 'student', studentUserId: ids.s1 },
    });
    await ok(admin, 'PUT', '/api/attendance/device-pins', {
      pin: '7001',
      target: { type: 'employee', employeeId: ids.emp },
    });
    const res = await push(serial('A'), 'ATTLOG', fixture('attlog.txt', { Y, FUTURE, STALE }), {
      Stamp: '9001',
    });
    expect(res.status, res.text).toBe(200);
    expect(res.text).toBe('OK: 11');

    const list = await events(admin, dev.A.id);
    expect(list).toHaveLength(8);
    const count = (status: string) => list.filter((e) => e.status === status).length;
    expect({ applied: count('applied'), ignored: count('ignored'), unmatched: count('unmatched') }).toEqual({
      applied: 3,
      ignored: 2,
      unmatched: 3,
    });
    const at = (time: string) => new Date(`${Y}T${time}+05:30`).toISOString();
    expect(list.find((e) => e.punchedAt === at('09:55:00'))).toMatchObject({
      enrolmentId: '1001',
      status: 'applied',
      direction: 'in',
      studentUserId: ids.s1,
    });
    expect(list.find((e) => e.punchedAt === at('11:05:00'))).toMatchObject({
      status: 'ignored',
      direction: 'out',
      note: 'Out punch',
    });
    expect(list.find((e) => e.status === 'ignored' && e.direction === 'in')?.note).toMatch(/in the future/);
    expect(list.filter((e) => e.enrolmentId === '7001').map((e) => [e.status, e.note])).toEqual([
      ['applied', 'Staff attendance'],
      ['applied', 'Staff attendance'],
    ]);
    expect(
      list
        .filter((e) => e.status === 'unmatched')
        .map((e) => e.enrolmentId)
        .sort(),
    ).toEqual(['2002', '404', '404']);

    const { roster } = await ok(admin, 'POST', '/api/attendance/sessions', { classSessionId: ids.cls });
    expect(roster.find((r: { studentUserId: number }) => r.studentUserId === ids.s1)).toMatchObject({
      status: 'present',
      source: 'biometric',
    });
    expect(await ok(admin, 'GET', `/api/hr/attendance?from=${Y}&to=${Y}&employeeId=${ids.emp}`)).toEqual([
      expect.objectContaining({ date: Y, checkIn: '09:00', checkOut: '18:30', source: 'biometric' }),
    ]);

    expect((await deviceDto(admin, dev.A.id)).lastError).toBe(
      'Skipped attendance records: 2 unreadable, 1 older than 31 days',
    );
    expect((await handshake(serial('A'))).text).toContain('ATTLOGStamp=9001');
  });

  it('acknowledges re-sent batches without applying them twice', async () => {
    const body = fixture('attlog.txt', { Y, FUTURE, STALE });
    const before = await events(admin, dev.A.id);
    expect((await push(serial('A'), 'ATTLOG', body, { Stamp: '9001' })).text).toBe('OK: 11');
    const again = await Promise.all(
      [1, 2, 3].map(() => push(serial('A'), 'ATTLOG', body, { Stamp: '9001' })),
    );
    expect(again.map((r) => r.text)).toEqual(['OK: 11', 'OK: 11', 'OK: 11']);
    expect(await events(admin, dev.A.id)).toEqual(before);
    expect(await ok(admin, 'GET', `/api/hr/attendance?from=${Y}&to=${Y}&employeeId=${ids.emp}`)).toEqual([
      expect.objectContaining({ checkIn: '09:00', checkOut: '18:30' }),
    ]);
  });

  it('reads punch times in the device time zone', async () => {
    expect((await push(serial('C'), 'ATTLOG', `6006\t${Y} 09:00:00\t0\t1\t0\t0\t0\n`)).text).toBe('OK: 1');
    expect(await events(admin, dev.C.id)).toEqual([
      expect.objectContaining({ enrolmentId: '6006', punchedAt: `${Y}T09:00:00.000Z`, status: 'unmatched' }),
    ]);
  });

  it('keeps device user lists for PIN mapping', async () => {
    expect((await push(serial('A'), 'USERINFO', 'PIN=9009\tName=Temp User\tPri=0\n')).text).toBe('OK: 1');
    const res = await push(serial('A'), 'OPERLOG', fixture('operlog.txt', { Y }), { Stamp: '5001' });
    expect(res.text).toBe('OK: 9');
    expect((await deviceDto(admin, dev.A.id)).lastError).toBe('Skipped 1 unreadable user records');
    expect((await push(serial('B'), 'USERINFO', 'PIN=3003\tName=Dev B User\tPri=0\n')).text).toBe('OK: 1');

    const pins: DevicePinDto[] = await ok(admin, 'GET', '/api/attendance/device-pins');
    // Unmapped PINs with punches first, then other unmapped ones, then mapped ones.
    expect(pins.map((p) => p.pin)).toEqual(['404', '2002', '6006', '3003', '5005', '1001', '7001', '8008']);
    const pin = (p: string) => pins.find((x) => x.pin === p);
    expect(pin('1001')).toMatchObject({
      deviceName: 'Asha',
      deviceIds: [dev.A.id],
      student: { userId: ids.s1, name: 'Asha ADMS' },
      employee: null,
      hidden: false,
    });
    expect(pin('7001')).toMatchObject({
      deviceName: 'Ravi Staff',
      employee: { id: ids.emp, name: 'Ravi Staff' },
    });
    expect(pin('8008')).toMatchObject({ deviceName: 'Nila', employee: { id: ids.emp2, name: 'Nila Two' } });
    expect(pin('3003')).toMatchObject({
      deviceName: 'Dev B User',
      deviceIds: [dev.B.id],
      unmatchedPunches: 0,
    });
    expect(pin('404')).toMatchObject({ deviceName: null, deviceIds: [dev.A.id], unmatchedPunches: 2 });
    expect(pin('6006')).toMatchObject({ deviceIds: [dev.C.id], unmatchedPunches: 1 });
  });

  it('applies earlier punches when a PIN is mapped', async () => {
    const mapped = await ok(admin, 'PUT', '/api/attendance/device-pins', {
      pin: '2002',
      target: { type: 'student', studentUserId: ids.s2 },
    });
    expect(mapped.reapplied).toMatchObject({ applied: 1, unmatched: 0 });
    const { roster } = await ok(admin, 'POST', '/api/attendance/sessions', { classSessionId: ids.cls });
    expect(roster.find((r: { studentUserId: number }) => r.studentUserId === ids.s2)).toMatchObject({
      status: 'late',
      source: 'biometric',
    });
    // Only students can be mapped as students.
    expect((await putPin(admin, '404', { type: 'student', studentUserId: ids.teacher })).status).toBe(404);
    expect(await ok(admin, 'PUT', '/api/attendance/device-pins', { pin: '2002', target: null })).toEqual({
      reapplied: null,
    });
  });

  it("limits PIN mapping to the caller's branches", async () => {
    await ok(admin, 'PUT', '/api/attendance/device-pins', {
      pin: '5005',
      target: { type: 'student', studentUserId: ids.s3 },
    });
    const byId = (a: number, b: number) => a - b;
    const devices: AttendanceDeviceDto[] = await ok(clerk, 'GET', '/api/attendance/devices');
    expect(devices.map((d) => d.id).sort(byId)).toEqual([dev.A.id, dev.C.id, dev.api.id].sort(byId));

    const pins: DevicePinDto[] = await ok(clerk, 'GET', '/api/attendance/device-pins');
    expect(pins.map((p) => p.pin)).toEqual(['404', '6006', '2002', '1001', '5005', '7001', '8008']);
    const pin = (p: string) => pins.find((x) => x.pin === p);
    expect(pin('5005')).toMatchObject({ hidden: true, student: null, employee: null });
    expect(pin('8008')).toMatchObject({ hidden: true, student: null, employee: null });
    // Without hr.view the employee is shown without a name.
    expect(pin('7001')).toMatchObject({ hidden: false, employee: { id: ids.emp, name: null } });
    expect(JSON.stringify(pins)).not.toMatch(/Charu ADMS|Nila Two|Dev B User/);

    expect((await putPin(clerk, '404', { type: 'student', studentUserId: ids.s3 })).status).toBe(404);
    const inUse = await putPin(clerk, '5005', { type: 'student', studentUserId: ids.s1 });
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('PIN_IN_USE');
    expect((await putPin(clerk, '404', { type: 'employee', employeeId: ids.emp })).status).toBe(403);
    expect((await putPin(clerk2, '404', { type: 'employee', employeeId: ids.emp2 })).status).toBe(404);
    const named: DevicePinDto[] = await ok(clerk2, 'GET', '/api/attendance/device-pins');
    expect(named.find((p) => p.pin === '7001')?.employee).toEqual({ id: ids.emp, name: 'Ravi Staff' });
    expect((await send(clerk, 'GET', `/api/attendance/devices/${dev.B.id}/commands`)).status).toBe(404);
  });

  it("keeps each institute's devices, PINs and punches apart", async () => {
    const before = await events(admin, dev.A.id);
    expect((await push(serial('BETA'), 'ATTLOG', `1001\t${Y} 09:50:00\t0\t1\t0\t0\t0\n`)).text).toBe('OK: 1');
    expect(await events(B.admin, dev.beta.id)).toEqual([
      expect.objectContaining({ enrolmentId: '1001', status: 'unmatched', studentUserId: null }),
    ]);
    expect(await events(admin, dev.A.id)).toEqual(before);
    const pins: DevicePinDto[] = await ok(B.admin, 'GET', '/api/attendance/device-pins');
    expect(pins).toEqual([
      expect.objectContaining({
        pin: '1001',
        deviceName: null,
        deviceIds: [dev.beta.id],
        student: null,
        employee: null,
        hidden: false,
        unmatchedPunches: 1,
      }),
    ]);
    expect((await send(B.admin, 'GET', `/api/attendance/devices/${dev.A.id}/commands`)).status).toBe(404);
    expect((await putPin(B.admin, '1001', { type: 'student', studentUserId: ids.s1 })).status).toBe(404);
  });

  it('queues commands and delivers them when the device polls', async () => {
    const queue = (body: unknown, id = dev.A.id) =>
      send(admin, 'POST', `/api/attendance/devices/${id}/commands`, body);
    const command = async (body: unknown): Promise<DeviceCommandDto> => {
      const res = await queue(body);
      expect(res.status, res.text).toBe(201);
      return res.body;
    };
    const sync = await command({ kind: 'sync_clock' });
    const info = await command({ kind: 'device_info' });
    const logs = await command({ kind: 'fetch_logs', from: Y, to: TODAY });
    expect([sync, info, logs].map((c) => [c.status, c.command])).toEqual([
      ['pending', 'RELOAD OPTIONS'],
      ['pending', 'INFO'],
      ['pending', `DATA QUERY ATTLOG StartTime=${Y} 00:00:00\tEndTime=${TODAY} 23:59:59`],
    ]);
    for (const [body, id, status] of [
      [{ kind: 'fetch_logs', from: TODAY, to: Y }, dev.A.id, 400],
      [{ kind: 'fetch_logs', from: STALE, to: TODAY }, dev.A.id, 400],
      [{ kind: 'sync_clock' }, dev.api.id, 400],
      [{ kind: 'fetch_user', pin: 'bad pin' }, dev.A.id, 422],
      [{ kind: 'reboot' }, dev.A.id, 422],
    ] as const)
      expect((await queue(body, id)).status, JSON.stringify(body)).toBe(status);

    const first = await poll(serial('A'), {
      INFO: 'Ver 6.60 Apr 28 2021,12,10,345,192.168.1.201,10,7,15,15,111',
    });
    expect(first.text.split('\n')).toEqual([
      `C:${sync.id}:RELOAD OPTIONS`,
      `C:${info.id}:INFO`,
      `C:${logs.id}:${logs.command}`,
    ]);
    expect((await poll(serial('A'))).text).toBe('OK');

    const answer = fixture('devicecmd-info.txt', { SYNC: sync.id, INFO: info.id, QUERY: logs.id });
    expect(
      (await iclock('post', '/iclock/devicecmd', { query: { SN: serial('A') }, body: answer })).text,
    ).toBe('OK');
    const list: DeviceCommandDto[] = await ok(admin, 'GET', `/api/attendance/devices/${dev.A.id}/commands`);
    const byId = (id: number) => list.find((c) => c.id === id);
    expect(byId(sync.id)).toMatchObject({ status: 'done', returnCode: 0, sentAt: expect.any(String) });
    expect(byId(info.id)).toMatchObject({ status: 'done', returnCode: 0, completedAt: expect.any(String) });
    expect(byId(logs.id)).toMatchObject({ status: 'failed', returnCode: -1002 });
    expect((await deviceDto(admin, dev.A.id)).info).toEqual({
      pushVersion: '2.4.1',
      deviceName: 'SpeedFace-V5L',
      firmware: '6.60 Apr 28 2021',
      platform: 'ZMM220_TFT',
      vendor: 'ZKTeco Inc.',
      users: 12,
      fingerprints: 10,
      faces: 15,
      attLogs: 345,
      ip: '192.168.1.201',
      mac: '00:17:61:12:34:56',
    });

    // A repeated answer, or another institute's device answering, changes nothing.
    await iclock('post', '/iclock/devicecmd', {
      query: { SN: serial('A') },
      body: `ID=${sync.id}&Return=-1&CMD=RELOAD OPTIONS\n`,
    });
    await iclock('post', '/iclock/devicecmd', {
      query: { SN: serial('BETA') },
      body: `ID=${info.id}&Return=-5&CMD=INFO\n`,
    });
    expect(await ok(admin, 'GET', `/api/attendance/devices/${dev.A.id}/commands`)).toEqual(list);

    // Re-reading the user list resets the OPERLOG pointer once.
    expect((await command({ kind: 'fetch_users' })).command).toBe('CHECK');
    expect(
      (await push(serial('A'), 'OPERLOG', 'USER PIN=1001\tName=Asha\tPri=0\n', { Stamp: '5002' })).text,
    ).toBe('OK: 1');
    expect((await handshake(serial('A'))).text).toContain('OPERLOGStamp=0');
    const next = (await handshake(serial('A'))).text;
    expect(next).toContain('OPERLOGStamp=9999');
    expect(next).toContain('ATTLOGStamp=9001');
  });

  it('caps waiting commands and expires stale ones', async () => {
    const queue = (kind: string) =>
      send(admin, 'POST', `/api/attendance/devices/${dev.C.id}/commands`, { kind });
    for (let i = 0; i < 20; i++) expect((await queue('sync_clock')).status).toBe(201);
    const over = await queue('sync_clock');
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('TOO_MANY_COMMANDS');

    await getSequelize().query('UPDATE attendance_device_commands SET created_at = ? WHERE device_id = ?', {
      replacements: [utc(new Date(Date.now() - 2 * DAY)), dev.C.id],
    });
    const listed: DeviceCommandDto[] = await ok(admin, 'GET', `/api/attendance/devices/${dev.C.id}/commands`);
    expect(listed.map((c) => c.status)).toEqual(Array(20).fill('expired'));
    const info = await queue('device_info');
    expect(info.status).toBe(201);
    expect((await poll(serial('C'))).text).toBe(`C:${info.body.id}:INFO`);
    const rows = await query<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM attendance_device_commands WHERE device_id = ? GROUP BY status',
      [dev.C.id],
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]))).toEqual({ expired: 20, sent: 1 });
  });

  it('refuses oversized or corrupt uploads before parsing them', async () => {
    const lastError = async () => (await deviceDto(admin, dev.C.id)).lastError;
    const line = `6006\t${Y} 08:00:00\t0\t1\t0\t0\t0`;
    expect((await push(serial('C'), 'ATTLOG', Array(10_001).fill(line).join('\n'))).status).toBe(413);
    expect(await lastError()).toBe('Refused an upload with more than 10000 records');
    expect((await push(serial('C'), 'ATTLOG', Buffer.alloc(2049 * 1024, 0x41))).status).toBe(413);
    expect(await lastError()).toBe('Refused an upload larger than 2048 KB');
    const bomb = gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x41));
    expect((await push(serial('C'), 'ATTLOG', bomb, { ContentType: 'tgz' })).status).toBe(413);
    expect(await lastError()).toBe('Refused an upload with more than 2048 KB of records');
    const corrupt = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);
    expect((await push(serial('C'), 'ATTLOG', corrupt, { ContentType: 'tgz' })).status).toBe(400);
    expect(await lastError()).toBe('Refused a corrupt data packet');

    const packet = gzipSync(ustar('ATTLOG.txt', `6006\t${Y} 09:30:00\t0\t1\t0\t0\t0\n`));
    expect((await push(serial('C'), 'ATTLOG', packet, { ContentType: 'tgz' })).text).toBe('OK: 1');
    const gzipped = gzipSync(Buffer.from(`6006\t${Y} 09:31:00\t0\t1\t0\t0\t0\n`));
    expect((await push(serial('C'), 'ATTLOG', gzipped)).text).toBe('OK: 1');
    expect((await events(admin, dev.C.id)).map((e) => e.punchedAt).sort()).toEqual([
      `${Y}T09:00:00.000Z`,
      `${Y}T09:30:00.000Z`,
      `${Y}T09:31:00.000Z`,
    ]);
  });

  it('applies the IP allowlist and the HTTPS rule, trusting forwarded headers only from the proxy', async () => {
    const app = await getApp();
    const patch = (body: unknown): Promise<AttendanceDeviceDto> =>
      ok(admin, 'PATCH', `/api/attendance/devices/${dev.C.id}`, body);
    const viaProxy = async (check: () => Promise<void>) => {
      app.set('trust proxy', 'loopback');
      try {
        await check();
      } finally {
        app.set('trust proxy', config.TRUST_PROXY);
      }
    };

    await patch({ ipAllowlist: ['203.0.113.0/24'] });
    const spoofed = await handshake(serial('C'), { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(spoofed.status).toBe(403);
    expect((await deviceDto(admin, dev.C.id)).lastError).toBe(
      "Refused a request from 127.0.0.1: not in the device's IP allowlist",
    );
    await viaProxy(async () => {
      expect((await handshake(serial('C'), { headers: { 'X-Forwarded-For': '203.0.113.7' } })).status).toBe(
        200,
      );
      expect((await handshake(serial('C'), { headers: { 'X-Forwarded-For': '198.51.100.7' } })).status).toBe(
        403,
      );
    });
    expect((await patch({ ipAllowlist: [] })).ipAllowlist).toEqual([]);

    expect((await patch({ allowHttp: false })).lastError).toBeNull();
    expect((await handshake(serial('C'), { headers: { 'X-Forwarded-Proto': 'https' } })).status).toBe(403);
    expect((await deviceDto(admin, dev.C.id)).lastError).toBe(
      'Refused a plain-HTTP request: use HTTPS on the device, or allow plain HTTP for it',
    );
    await viaProxy(async () => {
      expect((await handshake(serial('C'), { headers: { 'X-Forwarded-Proto': 'https' } })).status).toBe(200);
    });
    await patch({ allowHttp: true });
  });

  it('acknowledges other endpoints and tables, and refuses devices while attendance is off', async () => {
    expect((await iclock('get', '/iclock/ping', { query: { SN: serial('A') } })).text).toBe('OK');
    const photo = await iclock('post', '/iclock/fdata', {
      query: { SN: serial('A'), table: 'ATTPHOTO' },
      body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });
    expect(photo.text).toBe('OK');
    expect(
      (await push(serial('A'), 'BIODATA', 'BIODATA Pin=1001\tNo=0\tIndex=0\tValid=1\tTmp=AAAA\n')).text,
    ).toBe('OK');
    expect((await push(serial('A'), 'options', fixture('options.txt'))).text).toBe('OK');
    expect((await deviceDto(admin, dev.A.id)).info?.attLogs).toBe(346);
    // Whatever content type the firmware claims, the body is read as text.
    const json = await push(
      serial('C'),
      'ATTLOG',
      `6006\t${Y} 09:45:00\t0\t1\t0\t0\t0\n`,
      {},
      {
        'Content-Type': 'application/json',
      },
    );
    expect(json.text).toBe('OK: 1');
    expect((await iclock('get', '/iclock/exchange', { query: { SN: serial('A') } })).status).toBe(404);

    const sub = (await getActiveSubscription(A.id))!;
    const saved = sub.limitOverrides;
    await sub.update({
      limitOverrides: {
        ...((saved as Record<string, unknown> | null) ?? {}),
        enabledModules: PLAN_MODULE_KEYS.filter((k) => k !== 'attendance'),
      },
    });
    try {
      expect((await handshake(serial('A'))).status).toBe(403);
      const [row] = await query<{ last_error: string }>(
        'SELECT last_error FROM attendance_devices WHERE id = ?',
        [dev.A.id],
      );
      expect(row.last_error).toBe('Refused a request: attendance is not enabled for this institute');
    } finally {
      await sub.update({ limitOverrides: saved as never });
    }
    expect((await handshake(serial('A'))).status).toBe(200);
  });
});
