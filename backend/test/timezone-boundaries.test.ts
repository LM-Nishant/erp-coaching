import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWithContext } from '../src/shared/context';
import { DEFAULT_INSTITUTE_TIMEZONE, getInstituteTimezone } from '../src/shared/timezone';
import { today as academicsToday } from '../src/modules/academics/academics.service';
import { outstandingReport } from '../src/modules/fees/accounting.service';
import { instalmentDto } from '../src/modules/fees/accounts.service';
import { FeeInstalment } from '../src/modules/fees/models';
import { resolveFeeNumberTarget } from '../src/modules/fees/numbering';
import { financialYear, today as feesToday } from '../src/modules/fees/util';
import { StaffAttendance } from '../src/modules/hr/models';
import { AcademicSession, Batch, Course } from '../src/modules/academics/models';
import { Branch } from '../src/modules/branches/branch.model';
import { Guardian } from '../src/modules/guardians/models';
import { childTimetable, previousPeriod } from '../src/modules/parent-portal/parent-portal.service';
import { resolveBlocks } from '../src/modules/website/content.service';
import type { WebsiteBlock } from '@erp/shared';
import { USERS, bearer, getApp, login, purgeRows } from './helpers';

// A UTC server clock, so institute-day logic can't pass by accident on an IST machine.
const originalTz = process.env.TZ;
process.env.TZ = 'UTC';

const APEX = 1;
const system = <T>(fn: () => Promise<T>) =>
  runWithContext({ system: true, instituteId: APEX, allowedBranchIds: null }, fn);

/** Runs `fn` as the Apex system context with the clock set to `iso`. */
async function at<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
  try {
    return await system(fn);
  } finally {
    vi.useRealTimers();
  }
}

describe('institute-day logic around midnight (Asia/Kolkata institute, UTC server)', () => {
  let admin: string;
  const employeeIds: number[] = [];

  beforeAll(async () => {
    await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    expect(await getInstituteTimezone(APEX)).toBe(DEFAULT_INSTITUTE_TIMEZONE);
  });

  afterAll(async () => {
    await purgeRows('employees', employeeIds);
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('labels the Indian financial year of a calendar date', () => {
    expect(financialYear('2026-03-31')).toBe('2025-26');
    expect(financialYear('2026-04-01')).toBe('2026-27');
  });

  it.each([
    ['2026-03-31T18:20:00Z', '2025-26/2026/26/03'], // 23:50 IST, 31 Mar
    ['2026-03-31T18:45:00Z', '2026-27/2026/26/04'], // 00:15 IST, 1 Apr
    ['2026-04-30T18:20:00Z', '2026-27/2026/26/04'], // 23:50 IST, 30 Apr
    ['2026-04-30T18:35:00Z', '2026-27/2026/26/05'], // 00:05 IST, 1 May
    ['2026-12-31T18:45:00Z', '2026-27/2027/27/01'], // 00:15 IST, 1 Jan
  ])('numbers fee receipts by the institute day at %s', async (iso, period) => {
    const target = await system(() =>
      resolveFeeNumberTarget('receipt', '{FY}/{YYYY}/{YY}/{MM}/{SEQ:4}', null, new Date(iso)),
    );
    expect(target).toEqual({ kind: 'receipt', scopeKey: `${period}/{SEQ}`, width: 4 });
  });

  it("numbers fee invoices in the institute's configured timezone", async () => {
    const app = await getApp();
    const setTz = (value: string) =>
      request(app).put('/api/institute/settings/timezone').set(bearer(admin)).send({ value });
    expect((await setTz('America/New_York')).status).toBe(200);
    try {
      // 03:30 UTC / 09:00 IST on 1 Apr is still 23:30 on 31 Mar in New York.
      const target = await system(() =>
        resolveFeeNumberTarget('invoice', 'INV/{FY}/{MM}/', null, new Date('2026-04-01T03:30:00Z')),
      );
      expect(target.scopeKey).toBe('INV/2025-26/03/{SEQ}');
    } finally {
      expect((await setTz(DEFAULT_INSTITUTE_TIMEZONE)).status).toBe(200);
    }
  });

  it("uses the institute's day as 'today' in fees and academics", async () => {
    expect(await at('2026-03-31T18:45:00Z', feesToday)).toBe('2026-04-01');
    expect(await at('2026-03-31T18:45:00Z', academicsToday)).toBe('2026-04-01');
    expect(await at('2026-04-30T18:20:00Z', feesToday)).toBe('2026-04-30');
    expect(await at('2026-04-30T18:20:00Z', academicsToday)).toBe('2026-04-30');
    expect((await at('2026-03-31T18:45:00Z', () => outstandingReport({}))).asOf).toBe('2026-04-01');
  });

  it('treats an instalment as due (not overdue) until the institute day ends', async () => {
    const instalment = FeeInstalment.build({
      instituteId: APEX,
      accountId: 0,
      seq: 1,
      label: 'Term 1',
      dueDate: '2026-03-31',
      amount: 50000,
    });
    expect(instalmentDto(instalment, await at('2026-03-31T18:20:00Z', feesToday)).overdue).toBe(false);
    expect(instalmentDto(instalment, await at('2026-03-31T18:45:00Z', feesToday)).overdue).toBe(true);
  });

  it('files staff biometric punches under the institute day and wall-clock time', async () => {
    const app = await getApp();
    const enrolmentId = `TZB-${Date.now()}`;
    const emp = await request(app)
      .post('/api/hr/employees')
      .set(bearer(admin))
      .send({ name: 'Boundary Staff', dateOfJoining: '2026-01-01', biometricEnrolmentId: enrolmentId });
    expect(emp.status).toBe(201);
    employeeIds.push(emp.body.id);

    const punch = (punchedAt: string) => ({ deviceSerial: 'TZ-DEV', enrolmentId, punchedAt });
    const res = await request(app)
      .post('/api/hr/attendance/biometric')
      .set(bearer(admin))
      .send({
        punches: [
          punch('2026-03-31T18:45:00Z'), // 00:15 IST, 1 Apr
          punch('2026-04-01T03:30:00Z'), // 09:00 IST, 1 Apr
          punch('2026-04-30T18:20:00Z'), // 23:50 IST, 30 Apr
          // Device wall-clock stamps (no offset) are institute time, not server (UTC) time.
          punch('2026-05-01T00:10:00'),
          punch('2026-05-01 23:55:00'),
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ punches: 5, updated: 3, skipped: 0, unmatched: [] });

    const rows = await StaffAttendance.findAll({
      where: { instituteId: APEX, employeeId: emp.body.id },
      order: [['date', 'ASC']],
    });
    expect(rows.map((r) => [r.date, r.checkIn?.slice(0, 5), r.checkOut?.slice(0, 5) ?? null])).toEqual([
      ['2026-04-01', '00:15', '09:00'],
      ['2026-04-30', '23:50', null],
      ['2026-05-01', '00:10', '23:55'],
    ]);
  });
});

describe('parent portal and website dates around midnight (Asia/Kolkata institute, UTC server)', () => {
  const ids = { batches: [] as number[], courses: [] as number[], sessions: [] as number[] };
  const people = { students: [] as number[], guardians: [] as number[], users: [] as number[] };

  afterAll(async () => {
    await purgeRows('batches', ids.batches);
    await purgeRows('courses', ids.courses);
    await purgeRows('academic_sessions', ids.sessions);
    await purgeRows('guardians', people.guardians);
    await purgeRows('students', people.students);
    await purgeRows('users', people.users);
  });

  it.each([
    ['Asia/Kolkata', '2026-03-31T18:20:00Z', '2026-02'], // 23:50 IST, 31 Mar
    ['Asia/Kolkata', '2026-03-31T18:45:00Z', '2026-03'], // 00:15 IST, 1 Apr
    ['Asia/Kolkata', '2026-12-31T18:45:00Z', '2026-12'], // 00:15 IST, 1 Jan
    ['America/New_York', '2026-04-01T03:30:00Z', '2026-02'], // 23:30, 31 Mar in New York
  ])('picks the previous report month in %s at %s', (tz, iso, period) => {
    expect(previousPeriod(tz, new Date(iso))).toBe(period);
  });

  it("starts a parent's default timetable on the institute day", async () => {
    const app = await getApp();
    const admin = (await login(USERS.apexAdmin)).accessToken;
    const tag = String(Date.now()).slice(-6);
    const student = await request(app)
      .post('/api/students')
      .set(bearer(admin))
      .send({ name: 'TZ Boundary Child', mobile: `9490${tag}` });
    expect(student.status, JSON.stringify(student.body)).toBe(201);
    people.students.push(student.body.id);
    people.users.push(student.body.userId);
    const parentMobile = `9491${tag}`;
    const linked = await request(app)
      .post(`/api/students/${student.body.id}/guardians`)
      .set(bearer(admin))
      .send({ name: 'TZ Boundary Parent', mobile: parentMobile, relation: 'mother' });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    const guardian = await Guardian.findOne({ where: { instituteId: APEX, mobile: parentMobile } });
    expect(guardian?.userId).toBeTruthy();
    people.guardians.push(guardian!.id);
    people.users.push(guardian!.userId);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-31T18:45:00Z')); // 00:15 IST, 1 Apr
    try {
      const tt = await runWithContext(
        { instituteId: APEX, allowedBranchIds: null, userId: guardian!.userId },
        () => childTimetable(student.body.id, {}),
      );
      expect([tt.from, tt.to]).toEqual(['2026-04-01', '2026-04-07']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides website batches that ended before the institute day', async () => {
    await getApp();
    const branch = await Branch.findOne({ where: { instituteId: APEX }, order: [['id', 'ASC']] });
    const tag = String(Date.now()).slice(-6);
    // 00:15 IST on the most recent institute day (recent, so the subscription is active), when the UTC
    // date is still the day before.
    const IST = 330 * 60_000;
    let instant = Math.floor((Date.now() + IST) / 86_400_000) * 86_400_000 - IST + 15 * 60_000;
    if (instant > Date.now()) instant -= 86_400_000;
    const today = new Date(instant + IST).toISOString().slice(0, 10);
    const yesterday = new Date(instant).toISOString().slice(0, 10);
    expect(yesterday < today).toBe(true);
    const { course, open } = await system(async () => {
      // Non-current session: other suites treat institute 1's first session as current.
      const session = await AcademicSession.create({
        instituteId: APEX,
        name: `TZB ${tag}`,
        startDate: '2060-04-01',
        endDate: '2061-03-31',
      } as never);
      ids.sessions.push(session.id);
      const course = await Course.create({
        instituteId: APEX,
        name: 'TZB Course',
        code: `TZB-${tag}`,
      } as never);
      ids.courses.push(course.id);
      const batch = async (code: string, endDate: string) => {
        const b = await Batch.create({
          instituteId: APEX,
          branchId: branch!.id,
          courseId: course.id,
          academicSessionId: session.id,
          name: code,
          code: `${code}-${tag}`,
          capacity: 10,
          startDate: '2026-01-01',
          endDate,
          status: 'active',
        } as never);
        ids.batches.push(b.id);
        return b;
      };
      await batch('TZB-ENDED', yesterday);
      return { course, open: await batch('TZB-OPEN', today) };
    });

    const block = { id: 'b1', type: 'batches', settings: { courseId: course.id } } as unknown as WebsiteBlock;
    const [resolved] = await at(new Date(instant).toISOString(), () => resolveBlocks([block]));
    const listed = (resolved as unknown as { data: { batches: { id: number }[] } }).data.batches;
    expect(listed.map((b) => b.id)).toEqual([open.id]);
  });
});
