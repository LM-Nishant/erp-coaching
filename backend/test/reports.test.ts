import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REPORT_KEYS,
  REPORT_MAX_RANGE_DAYS,
  type ReportMetricDto,
  type RoleDashboardDto,
  type SaasBillingStatsDto,
} from '@erp/shared';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import type { Job } from '../src/infrastructure/jobs/job.model';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { getStorage } from '../src/infrastructure/storage';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { runWithContext } from '../src/shared/context';
import { DEFAULT_INSTITUTE_TIMEZONE, todayIn } from '../src/shared/timezone';
import { Branch } from '../src/modules/branches/branch.model';
import { FileObject } from '../src/modules/files/file.model';
import { Institute } from '../src/modules/institutes/institute.model';
import { setSaasBillingStatsProvider, type SaasPeriod } from '../src/modules/reports/api';
import {
  EXPIRE_JOB,
  EXPORT_JOB,
  expireExportJob,
  exportLimits,
  runExportJob,
} from '../src/modules/reports/exports.service';
import { ReportExport } from '../src/modules/reports/models';
import { getActiveSubscription } from '../src/modules/subscriptions/subscription.service';
import {
  DEMO_PASSWORD,
  USERS,
  bearer,
  getApp,
  lastOtpFor,
  login,
  newDevice,
  purgeAcademicFixtures,
  purgeRows,
} from './helpers';

let seq = 0;
// 941… mobiles belong to this suite; afterAll purges them.
const mobile = () => `941${String(seq++).padStart(7, '0')}`;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const asApex = <T>(fn: () => Promise<T>) =>
  runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, fn);
const values = (metrics: Pick<ReportMetricDto, 'key' | 'value'>[]) =>
  Object.fromEntries(metrics.map((m) => [m.key, m.value]));
const group = (dash: RoleDashboardDto, key: string) => {
  const g = dash.groups.find((x) => x.key === key);
  return g ? values(g.metrics) : undefined;
};

describe('reports & analytics', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  const t: Record<string, string> = {}; // access tokens
  const ids: Record<string, number> = {};
  const today = todayIn(DEFAULT_INSTITUTE_TIMEZONE);
  const day = addDays(today, -3);
  const range = { from: addDays(today, -10), to: today };

  const get = (token: string, path: string, query: Record<string, unknown> = {}) =>
    request(app).get(`/api/reports${path}`).query(query).set(bearer(token));
  const report = async (token: string, key: string, query: Record<string, unknown> = {}) => {
    const res = await get(token, `/${key}`, { ...range, ...query });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      summary: ReportMetricDto[];
      scope: { audience: string; label: string };
      tables: { key: string; rows: Record<string, unknown>[]; totalRows: number }[];
    };
  };
  const exportReport = (token: string, key: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/reports/${key}/exports`)
      .set(bearer(token))
      .send({ ...range, ...body });
  const binary = (path: string) =>
    request(app)
      .get(path)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  /** Signs a download for the caller's export and fetches the file. */
  const download = async (token: string, exportId: number) => {
    const signed = await request(app).post(`/api/reports/exports/${exportId}/download`).set(bearer(token));
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const file = await binary(new URL(signed.body.url).pathname);
    expect(file.status).toBe(200);
    return { fileName: signed.body.fileName as string, body: file.body as Buffer };
  };

  async function otpLogin(m: string) {
    const device = newDevice();
    const ch = await request(app).post('/api/auth/otp/request').send({ mobile: m, device });
    const res = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: ch.body.challengeId, code: lastOtpFor(m), device });
    expect(res.body.status).toBe('authenticated');
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    app = await getApp();
    t.admin = (await login(USERS.apexAdmin)).accessToken;
    t.zenith = (await login(USERS.zenithAdmin)).accessToken;
    t.sa = (await login(USERS.superAdmin)).accessToken;
    const admin = bearer(t.admin);
    const post = async (path: string, body: object) => {
      const res = await request(app).post(path).set(admin).send(body);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(201);
      return res.body;
    };

    // A branch of its own keeps the per-branch figures exact whatever other suites leave behind.
    ids.main = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    ids.qa = (await asApex(() => Branch.create({ instituteId: 1, name: 'RPT QA', code: 'RPT-QA' }))).id;

    const roles = (await request(app).get('/api/roles').set(admin)).body as { id: number; slug: string }[];
    const role = (slug: string) => roles.find((r) => r.slug === slug)!.id;
    const staff = async (key: string, name: string, slug: string, branchId: number | null) => {
      const m = mobile();
      const u = await post('/api/users', {
        name,
        mobile: m,
        password: DEMO_PASSWORD,
        roles: [{ roleId: role(slug), branchId }],
        branchIds: [ids.qa],
      });
      ids[key] = u.id;
      t[key] = (await login({ mobile: m, password: DEMO_PASSWORD })).accessToken;
    };
    await staff('branchAdmin', 'RPT Branch Admin', 'branch-admin', ids.qa);
    await staff('accountant', 'RPT Accountant', 'accountant', null);
    await staff('teacherA', 'RPT Teacher A', 'teacher', ids.qa);
    await staff('teacherB', 'RPT Teacher B', 'teacher', ids.qa);

    const students: [string, string, number][] = [
      ['s1', 'RPT Student One', ids.qa],
      ['s2', 'RPT Student Two', ids.qa],
      ['s3', 'RPT Student Three', ids.qa],
      ['s4', 'RPT Student Four', ids.main],
    ];
    const mobiles: Record<string, string> = {};
    for (const [key, name, branchId] of students) {
      mobiles[key] = mobile();
      const s = await post('/api/students', { name, mobile: mobiles[key], branchId });
      ids[`${key}Student`] = s.id;
      ids[`${key}User`] = s.userId;
    }
    const parentMobile = mobile();
    await post(`/api/students/${ids.s1Student}/guardians`, {
      name: 'RPT Parent',
      mobile: parentMobile,
      relation: 'mother',
    });
    t.s1 = await otpLogin(mobiles.s1);
    t.parent = await otpLogin(parentMobile);

    // Academics: batch A (capacity 2, full) taught by teacher A; batch B (capacity 10) by teacher B.
    ids.session = (
      await post('/api/academics/sessions', {
        name: 'RPT-2050',
        startDate: '2020-01-01',
        endDate: '2050-12-31',
      })
    ).id;
    ids.course = (
      await post('/api/academics/courses', { name: 'RPT Course', code: 'RPT-C', branchIds: [ids.qa] })
    ).id;
    const batch = async (code: string, capacity: number, teacher: number, studentUserIds: number[]) => {
      const b = await post('/api/academics/batches', {
        branchId: ids.qa,
        courseId: ids.course,
        academicSessionId: ids.session,
        name: `RPT Batch ${code}`,
        code: `RPT-${code}`,
        capacity,
        startDate: '2020-01-01',
        teachers: [{ teacherUserId: teacher }],
      });
      await post(`/api/academics/batches/${b.id}/students`, {
        studentUserIds,
        joinedOn: addDays(today, -30),
      });
      return b.id as number;
    };
    ids.batchA = await batch('A', 2, ids.teacherA, [ids.s1User, ids.s2User]);
    ids.batchB = await batch('B', 10, ids.teacherB, [ids.s3User]);

    // One class per batch three days ago: S1 present, S2 absent (batch A); S3 present (batch B).
    const mark = async (batchId: number, teacherUserId: number, records: [number, string][]) => {
      const cls = await post('/api/academics/class-sessions', {
        batchId,
        teacherUserId,
        date: day,
        startTime: '10:00',
        endTime: '11:00',
      });
      const att = await post('/api/attendance/sessions', { classSessionId: cls.id });
      const res = await request(app)
        .put(`/api/attendance/sessions/${att.session.id}/records`)
        .set(admin)
        .send({ records: records.map(([studentUserId, status]) => ({ studentUserId, status })) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return cls.id as number;
    };
    const classA = await mark(ids.batchA, ids.teacherA, [
      [ids.s1User, 'present'],
      [ids.s2User, 'absent'],
    ]);
    await mark(ids.batchB, ids.teacherB, [[ids.s3User, 'present']]);
    // Only completed classes count as teaching hours (the actual duration wins over the slot).
    const done = await request(app)
      .post(`/api/academics/class-sessions/${classA}/complete`)
      .set(admin)
      .send({ actualDurationMinutes: 90 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    // Fees: ₹10,000 due three days ago for S1, S2 (QA) and S4 (main); S1 paid ₹3,000 and S4 ₹2,000.
    ids.structure = (
      await post('/api/fees/structures', {
        name: 'RPT Fee',
        courseId: ids.course,
        components: [{ name: 'Tuition', amount: 1_000_000 }],
        instalmentPlan: { type: 'one_time', firstDueDate: day },
      })
    ).id;
    for (const key of ['s1', 's2', 's4']) {
      const acc = await post('/api/fees/accounts', {
        studentId: ids[`${key}Student`],
        structureId: ids.structure,
        firstDueDate: day,
      });
      ids[`${key}Account`] = acc.id;
    }
    for (const [key, amount] of [
      ['s1', 300_000],
      ['s4', 200_000],
    ] as const) {
      await post('/api/fees/payments/offline', {
        accountId: ids[`${key}Account`],
        amount,
        mode: 'cash',
        paidOn: day,
      });
    }

    // A grievance raised by S1 (in S1's branch).
    const categories = await request(app).get('/api/grievances/categories').set(admin);
    const ticket = await request(app)
      .post('/api/grievances')
      .set(bearer(t.s1))
      .send({ categoryId: categories.body[0].id, subject: 'RPT ticket', description: 'Projector broken' });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    ids.ticket = ticket.body.id;
  });

  afterAll(async () => {
    exportLimits.sync = 2000;
    setSaasBillingStatsProvider(null);
    const sequelize = getSequelize();
    const select = async (sql: string, replacements: unknown[] = []) =>
      ((await sequelize.query(sql, { replacements }))[0] as { id: number }[]).map((r) => r.id);
    const userIds = await select("SELECT id FROM users WHERE mobile LIKE '941%'");
    if (userIds.length) {
      await purgeRows(
        'report_exports',
        await select('SELECT id FROM report_exports WHERE user_id IN (?)', [userIds]),
      );
    }
    // Export files are removed from disk too, not just their rows.
    const [files] = await sequelize.query(
      "SELECT id, storage_key FROM files WHERE module = 'reports' AND institute_id = 1",
    );
    for (const f of files as { storage_key: string }[]) await getStorage().delete(f.storage_key);
    await purgeRows(
      'files',
      (files as { id: number }[]).map((f) => f.id),
    );
    await sequelize.query('DELETE FROM jobs WHERE name IN (?)', { replacements: [[EXPORT_JOB, EXPIRE_JOB]] });
    // grievances.test runs every pending SLA check; ours would point at a deleted ticket.
    if (ids.ticket) {
      await sequelize.query(
        "DELETE FROM jobs WHERE name = 'grievances.sla-check' AND JSON_EXTRACT(payload, '$.ticketId') = ?",
        { replacements: [ids.ticket] },
      );
    }
    // Whole journals (every line carries the fee account), so the ledger stays balanced.
    const accounts = [ids.s1Account, ids.s2Account, ids.s4Account].filter(Boolean);
    if (accounts.length) {
      await sequelize.query(
        'DELETE FROM fee_ledger_entries WHERE institute_id = 1 AND fee_account_id IN (?)',
        {
          replacements: [accounts],
        },
      );
    }
    await purgeRows('fee_accounts', accounts);
    // students.user_id is nullable, so purging the users alone would orphan the student rows.
    await purgeRows('students', [ids.s1Student, ids.s2Student, ids.s3Student, ids.s4Student]);
    await purgeRows('users', userIds);
    await purgeRows('fee_structures', [ids.structure]);
    await purgeAcademicFixtures({
      batchIds: [ids.batchA, ids.batchB],
      courseIds: [ids.course],
      sessionIds: [ids.session],
    });
    await purgeRows('branches', [ids.qa]);
  });

  it('validates the report key, filters and date range', async () => {
    expect((await request(app).get('/api/reports/catalog')).status).toBe(401);
    expect((await get(t.admin, '/no-such-report', range)).status).toBe(404);
    expect((await get(t.admin, '/Bad_Key', range)).status).toBe(422);
    // Payroll, grievances and appointments have no course/batch dimension.
    expect((await get(t.admin, '/grievances', { ...range, courseId: ids.course })).status).toBe(400);
    expect((await get(t.admin, '/attendance', { from: today, to: addDays(today, -1) })).status).toBe(400);
    expect(
      (await get(t.admin, '/attendance', { from: addDays(today, -REPORT_MAX_RANGE_DAYS), to: today })).status,
    ).toBe(400);
    expect((await get(t.admin, '/attendance', { from: today })).status).toBe(400);
    expect((await get(t.admin, '/attendance', { from: '2026-02-30', to: '2026-03-01' })).status).toBe(400);
    expect((await get(t.admin, '/attendance', { preset: 'last_7_days' })).body.period).toMatchObject({
      preset: 'last_7_days',
      from: addDays(today, -6),
      to: today,
      timezone: 'Asia/Kolkata',
    });
  });

  it('lists the reports each role may open', async () => {
    const catalog = async (token: string) => {
      const res = await get(token, '/catalog');
      expect(res.status).toBe(200);
      return res.body as { key: string; exportable: boolean }[];
    };
    const keys = async (token: string) => (await catalog(token)).map((c) => c.key);
    expect(await keys(t.branchAdmin)).toEqual([...REPORT_KEYS]);
    expect(await keys(t.accountant)).toEqual(['fee-collections', 'outstanding-dues', 'payroll']);
    expect(await keys(t.teacherA)).toEqual([
      'attendance',
      'exams',
      'teacher-performance',
      'appointments',
      'live-classes',
      'lms-engagement',
    ]);
    const studentReports = [
      'fee-collections',
      'outstanding-dues',
      'attendance',
      'exams',
      'grievances',
      'live-classes',
      'lms-engagement',
    ];
    expect(await keys(t.s1)).toEqual(studentReports);
    expect(await keys(t.parent)).toEqual([
      ...studentReports.slice(0, 5),
      'appointments',
      ...studentReports.slice(5),
    ]);
    expect((await catalog(t.teacherA)).every((c) => c.exportable)).toBe(true);
    expect((await catalog(t.parent)).some((c) => c.exportable)).toBe(false);
  });

  it('offers only the branches, courses and batches in the caller scope', async () => {
    const teacher = (await get(t.teacherA, '/filters')).body;
    expect(teacher).toMatchObject({
      audience: 'teacher',
      timezone: 'Asia/Kolkata',
      today,
      defaultPreset: 'this_month',
      branches: [{ id: ids.qa, name: 'RPT QA' }],
      courses: [{ id: ids.course, name: 'RPT Course' }],
      batches: [{ id: ids.batchA, branchId: ids.qa, courseId: ids.course }],
    });
    const parent = (await get(t.parent, '/filters')).body;
    expect(parent).toMatchObject({ audience: 'parent', branches: [], courses: [], batches: [] });
    const branchAdmin = (await get(t.branchAdmin, '/filters')).body;
    expect(branchAdmin.branches).toEqual([{ id: ids.qa, name: 'RPT QA' }]);
    const admin = (await get(t.admin, '/filters')).body;
    expect(admin.branches.map((b: { id: number }) => b.id)).toEqual(
      expect.arrayContaining([ids.main, ids.qa]),
    );
  });

  it('enforces tenant, branch, teacher and guardian scope', async () => {
    const code = async (token: string, key: string, query: Record<string, unknown> = {}) => {
      const res = await get(token, `/${key}`, { ...range, ...query });
      return [res.status, res.body.error?.code];
    };
    expect(await code(t.accountant, 'attendance')).toEqual([403, 'REPORT_FORBIDDEN']);
    expect(await code(t.branchAdmin, 'attendance', { branchId: ids.main })).toEqual([
      403,
      'BRANCH_FORBIDDEN',
    ]);
    expect(await code(t.teacherA, 'attendance', { batchId: ids.batchB })).toEqual([403, 'BATCH_FORBIDDEN']);
    expect((await code(t.zenith, 'attendance', { branchId: ids.qa }))[0]).toBe(404);
    expect((await code(t.zenith, 'attendance', { batchId: ids.batchA }))[0]).toBe(404);
    expect((await code(t.zenith, 'fee-collections', { courseId: ids.course }))[0]).toBe(404);
    expect((await code(t.s1, 'attendance', { branchId: ids.qa }))[0]).toBe(400);
    expect(await code(t.s1, 'payroll')).toEqual([403, 'REPORT_FORBIDDEN']);
    expect(await code(t.parent, 'capacity')).toEqual([403, 'REPORT_FORBIDDEN']);
  });

  it('reports fee collections and dues per branch, institute-wide and for families', async () => {
    const qa = await report(t.admin, 'fee-collections', { branchId: ids.qa });
    expect(qa.scope.label).toBe('Branch: RPT QA');
    expect(values(qa.summary)).toMatchObject({ net: 300_000, amount: 300_000, payments: 1, students: 1 });
    const own = await report(t.branchAdmin, 'fee-collections');
    expect(own.scope).toEqual({ audience: 'management', label: 'Branch: RPT QA' });
    expect(values(own.summary)).toMatchObject({ net: 300_000, payments: 1 });
    const all = await report(t.accountant, 'fee-collections');
    expect(all.scope).toEqual({ audience: 'finance', label: 'All branches' });
    expect(values(all.summary).net).toBeGreaterThanOrEqual(500_000);

    const dues = await report(t.branchAdmin, 'outstanding-dues');
    expect(values(dues.summary)).toMatchObject({
      balance: 1_700_000,
      overdue: 1_700_000,
      notYetDue: 0,
      accounts: 2,
      students: 2,
    });
    const mine = await report(t.s1, 'outstanding-dues');
    expect(mine.scope).toEqual({ audience: 'student', label: 'Your records' });
    expect(values(mine.summary)).toMatchObject({ balance: 700_000, accounts: 1 });
    expect(values(mine.summary)).not.toHaveProperty('students');
    const child = await report(t.parent, 'fee-collections');
    expect(child.scope).toEqual({ audience: 'parent', label: 'Your child: RPT Student One' });
    expect(values(child.summary)).toMatchObject({ net: 300_000, payments: 1 });
  });

  it('reports admissions and batch capacity for a branch', async () => {
    expect(values((await report(t.admin, 'admissions', { branchId: ids.qa })).summary)).toMatchObject({
      active: 3,
      admitted: 3,
      withdrawn: 0,
    });
    const capacity = await report(t.branchAdmin, 'capacity');
    expect(values(capacity.summary)).toMatchObject({
      utilisation: 25,
      enrolled: 3,
      seats: 12,
      batches: 2,
      full: 1,
      underHalf: 1,
    });
    expect(capacity.tables[0].key).toBe('batches');
    expect(capacity.tables[0].rows.map((r) => [r.code, r.enrolled, r.seatsLeft])).toEqual([
      ['RPT-A', 2, 0],
      ['RPT-B', 1, 9],
    ]);
  });

  it('reports attendance for the branch, a teacher, a batch, a course and a family', async () => {
    const qa = await report(t.branchAdmin, 'attendance');
    expect(values(qa.summary)).toMatchObject({
      percentage: 66.7,
      present: 2,
      absent: 1,
      sessions: 2,
      students: 3,
    });
    const teacher = await report(t.teacherA, 'attendance');
    expect(teacher.scope).toEqual({
      audience: 'teacher',
      label: 'Your batches and classes · Branch: RPT QA',
    });
    expect(values(teacher.summary)).toMatchObject({ percentage: 50, present: 1, absent: 1, students: 2 });
    const names = (teacher.tables.find((x) => x.key === 'students')?.rows ?? []).map((r) => r.student);
    expect(names.sort()).toEqual(['RPT Student One', 'RPT Student Two']);
    expect(values((await report(t.admin, 'attendance', { batchId: ids.batchB })).summary).percentage).toBe(
      100,
    );
    expect(values((await report(t.admin, 'attendance', { courseId: ids.course })).summary).percentage).toBe(
      66.7,
    );
    expect(values((await report(t.s1, 'attendance')).summary)).toMatchObject({ percentage: 100, present: 1 });
    const child = await report(t.parent, 'attendance');
    expect(child.scope.label).toBe('Your child: RPT Student One');
    expect(values(child.summary)).toMatchObject({ percentage: 100, present: 1, absent: 0 });
  });

  it('reports grievances and teacher performance within scope', async () => {
    expect(values((await report(t.admin, 'grievances', { branchId: ids.qa })).summary)).toMatchObject({
      tickets: 1,
      open: 1,
    });
    expect(values((await report(t.s1, 'grievances')).summary)).toMatchObject({ tickets: 1 });
    // Guardians see the tickets they raised themselves.
    expect(values((await report(t.parent, 'grievances')).summary)).toMatchObject({ tickets: 0 });

    const all = await report(t.admin, 'teacher-performance', { branchId: ids.qa });
    expect(values(all.summary)).toMatchObject({ teachers: 2, classes: 2, completion: 50, hours: 1.5 });
    const own = await report(t.teacherA, 'teacher-performance');
    expect(values(own.summary)).not.toHaveProperty('teachers');
    expect(values(own.summary)).toMatchObject({ classes: 1, completion: 100, hours: 1.5 });
    expect(own.tables[0].rows.map((r) => r.teacher)).toEqual(['RPT Teacher A']);
  });

  it('builds a dashboard for every role', async () => {
    const dash = async (token: string, query: Record<string, unknown> = {}) => {
      const res = await get(token, '/dashboard', { ...range, ...query });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as RoleDashboardDto;
    };
    const institute = await dash(t.admin);
    expect(institute).toMatchObject({ audience: 'management', title: 'Institute dashboard' });
    expect(institute.scope.label).toBe('All branches');
    expect(institute.branches!.rows.some((r) => Object.values(r).includes('RPT QA'))).toBe(true);
    expect(institute.reports).toEqual([...REPORT_KEYS]);

    const branch = await dash(t.admin, { branchId: ids.qa });
    expect(branch.title).toBe('Branch dashboard');
    expect(group(branch, 'fees')).toMatchObject({ collected: 300_000 });
    expect((await dash(t.branchAdmin)).title).toBe('Branch dashboard');

    const accounts = await dash(t.accountant);
    expect(accounts.title).toBe('Accounts dashboard');
    expect(accounts.groups.map((g) => g.key)).toEqual(['fees', 'dues', 'payroll']);

    const teaching = await dash(t.teacherA);
    expect(teaching.title).toBe('Teaching dashboard');
    expect(teaching.branches).toBeNull();
    expect(group(teaching, 'attendance')).toBeDefined();

    const mine = await dash(t.s1);
    expect(mine.title).toBe('My dashboard');
    expect(group(mine, 'fees')).toEqual({ paid: 300_000 });
    const children = await dash(t.parent);
    expect(children).toMatchObject({
      title: "Children's dashboard",
      scope: { audience: 'parent', label: 'Your child: RPT Student One' },
    });
    expect(group(children, 'dues')).toMatchObject({ balance: 700_000 });
  });

  it('respects the modules enabled on the plan', async () => {
    const sub = (await getActiveSubscription(1))!;
    const before = sub.limitOverrides;
    try {
      await sub.update({ limitOverrides: { ...(before ?? {}), enabledModules: ['attendance'] } });
      const off = await get(t.admin, '/catalog');
      expect([off.status, off.body.error?.code]).toEqual([403, 'MODULE_DISABLED']);

      await sub.update({ limitOverrides: { ...(before ?? {}), enabledModules: ['reports', 'attendance'] } });
      expect((await get(t.admin, '/catalog')).body.map((c: { key: string }) => c.key)).toEqual([
        'attendance',
      ]);
      expect((await get(t.admin, '/dashboard', range)).body.reports).toEqual(['attendance']);
      const fees = await get(t.admin, '/fee-collections', range);
      expect([fees.status, fees.body.error?.code]).toEqual([403, 'MODULE_DISABLED']);
    } finally {
      await sub.update({ limitOverrides: before });
    }
  });

  it('exports CSV, Excel and PDF immediately, audited and scoped', async () => {
    const csv = await exportReport(t.branchAdmin, 'fee-collections', { format: 'csv' });
    expect(csv.status, JSON.stringify(csv.body)).toBe(201);
    expect(csv.body).toMatchObject({
      reportKey: 'fee-collections',
      status: 'ready',
      format: 'csv',
      rowCount: 1,
      scopeLabel: 'Branch: RPT QA',
      fileName: `fee-collections-${range.from}-to-${range.to}.csv`,
    });
    const file = await download(t.branchAdmin, csv.body.id);
    expect([...file.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(file.body.toString('utf8')).toContain('RPT Student One');
    const audits = await AuditEvent.findAll({
      where: { entityType: 'report_export', entityId: String(csv.body.id) },
    });
    expect(audits.map((a) => a.action).sort()).toEqual(['report.export_downloaded', 'report.exported']);
    expect(audits.find((a) => a.action === 'report.exported')!.metadata).toMatchObject({
      report: 'fee-collections',
      format: 'csv',
      mode: 'immediate',
      scope: 'Branch: RPT QA',
    });

    const xlsx = await exportReport(t.branchAdmin, 'capacity', { format: 'xlsx' });
    expect(xlsx.status).toBe(201);
    expect((await download(t.branchAdmin, xlsx.body.id)).body.subarray(0, 2).toString()).toBe('PK');
    const pdf = await exportReport(t.branchAdmin, 'attendance', { format: 'pdf' });
    expect(pdf.status).toBe(201);
    expect((await download(t.branchAdmin, pdf.body.id)).body.subarray(0, 5).toString()).toBe('%PDF-');

    // A teacher's export holds only their own batches.
    const own = await exportReport(t.teacherA, 'attendance', { format: 'csv' });
    expect(own.status).toBe(201);
    const text = (await download(t.teacherA, own.body.id)).body.toString('utf8');
    expect(text).toContain('RPT Student One');
    expect(text).not.toContain('RPT Student Three');

    // Exports are private to their creator, and families cannot export.
    expect((await request(app).get(`/api/reports/exports/${own.body.id}`).set(bearer(t.admin))).status).toBe(
      404,
    );
    expect(
      (await request(app).post(`/api/reports/exports/${own.body.id}/download`).set(bearer(t.zenith))).status,
    ).toBe(404);
    expect((await exportReport(t.s1, 'attendance', { format: 'csv' })).status).toBe(403);
    const list = (await request(app).get('/api/reports/exports').set(bearer(t.teacherA))).body;
    expect(list.map((e: { id: number }) => e.id)).toEqual([own.body.id]);
  });

  it('runs large exports as background jobs with a ready notification', async () => {
    exportLimits.sync = 1; // any report with two or more rows goes to the queue
    try {
      const queued = await exportReport(t.branchAdmin, 'capacity', { format: 'csv' });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({ status: 'queued', rowCount: null });
      const early = await request(app)
        .post(`/api/reports/exports/${queued.body.id}/download`)
        .set(bearer(t.branchAdmin));
      expect([early.status, early.body.error.code]).toEqual([409, 'EXPORT_NOT_READY']);
      const audit = await AuditEvent.findOne({
        where: { action: 'report.exported', entityId: String(queued.body.id) },
      });
      expect(audit!.metadata).toMatchObject({ mode: 'background' });

      await processDueJobs();
      const ready = await request(app)
        .get(`/api/reports/exports/${queued.body.id}`)
        .set(bearer(t.branchAdmin));
      expect(ready.body).toMatchObject({ status: 'ready', rowCount: 2 });
      const inbox = await request(app).get('/api/notifications/inbox').set(bearer(t.branchAdmin));
      expect(inbox.body.items.map((m: { eventKey: string }) => m.eventKey)).toContain('reports.export-ready');
      const text = (await download(t.branchAdmin, queued.body.id)).body.toString('utf8');
      expect(text).toContain('RPT-A');
      expect(text).toContain('RPT-B');

      // At most three exports in flight per user.
      for (let i = 0; i < 3; i++) {
        expect((await exportReport(t.branchAdmin, 'capacity', { format: 'pdf' })).status).toBe(202);
      }
      const limited = await exportReport(t.branchAdmin, 'capacity', { format: 'pdf' });
      expect([limited.status, limited.body.error.code]).toEqual([429, 'TOO_MANY_EXPORTS']);
      await processDueJobs();
      expect((await exportReport(t.branchAdmin, 'capacity', { format: 'xlsx' })).status).toBe(202);
      await processDueJobs();
    } finally {
      exportLimits.sync = 2000;
    }
  });

  it('marks exports failed after the last attempt and never reruns them', async () => {
    exportLimits.sync = 1;
    let id: number;
    try {
      const queued = await exportReport(t.branchAdmin, 'capacity', { format: 'csv' });
      expect(queued.status).toBe(202);
      id = queued.body.id;
    } finally {
      exportLimits.sync = 2000;
    }
    await ReportExport.update(
      { reportKey: 'bogus' as ReportExport['reportKey'] },
      { where: { id, instituteId: 1 } },
    );
    const lastAttempt = { attempts: 3, maxAttempts: 3 } as unknown as Job;
    await expect(asApex(() => runExportJob({ exportId: id }, lastAttempt))).rejects.toThrow('Unknown report');
    const status = async () =>
      (await request(app).get(`/api/reports/exports/${id}`).set(bearer(t.branchAdmin))).body;
    expect(await status()).toMatchObject({ status: 'failed', error: 'Unknown report bogus' });
    const res = await request(app).post(`/api/reports/exports/${id}/download`).set(bearer(t.branchAdmin));
    expect([res.status, res.body.error.code]).toEqual([409, 'EXPORT_FAILED']);
    // The export's own queued job finds it final and leaves it alone.
    await processDueJobs();
    expect((await status()).status).toBe('failed');
  });

  it('expires downloads and deletes the file', async () => {
    const created = await exportReport(t.branchAdmin, 'outstanding-dues', { format: 'csv' });
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    const fileId = (await ReportExport.findOne({ where: { id, instituteId: 1 } }))!.fileId!;
    expect(fileId).toBeTruthy();
    await ReportExport.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id, instituteId: 1 } });
    const get1 = await request(app).get(`/api/reports/exports/${id}`).set(bearer(t.branchAdmin));
    expect(get1.body.status).toBe('expired');
    const res = await request(app).post(`/api/reports/exports/${id}/download`).set(bearer(t.branchAdmin));
    expect([res.status, res.body.error.code]).toEqual([410, 'EXPORT_EXPIRED']);

    await asApex(() => expireExportJob({ exportId: id }));
    const row = (await ReportExport.findOne({ where: { id, instituteId: 1 } }))!;
    expect([row.status, row.fileId]).toEqual(['expired', null]);
    expect(await FileObject.findOne({ where: { id: fileId, instituteId: 1 } })).toBeNull();
  });

  describe('SaaS dashboard', () => {
    const saas = (query: Record<string, unknown> = range) =>
      request(app).get('/api/admin/reports/dashboard').query(query).set(bearer(t.sa));

    it('is for super admins only and summarises every institute', async () => {
      expect((await request(app).get('/api/admin/reports/dashboard').set(bearer(t.admin))).status).toBe(403);
      const res = await saas();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.period).toMatchObject({ from: range.from, to: range.to });
      expect(res.body.revenue).toMatchObject({ source: 'subscriptions', currency: 'INR' });
      expect(res.body.institutes.total).toBeGreaterThanOrEqual(2);
      const apex = res.body.institutesTable.find((r: { id: number }) => r.id === 1);
      expect(apex).toMatchObject({ name: (await Institute.findByPk(1))!.name });
      expect(apex.students).toBeGreaterThanOrEqual(4);
      expect(apex.branches).toBeGreaterThanOrEqual(2);
    });

    it('uses the billing stats provider and falls back when it fails', async () => {
      const billing: SaasBillingStatsDto = {
        source: 'billing',
        currency: 'INR',
        mrrPaise: 123_00,
        arrPaise: 1476_00,
        revenueInPeriodPaise: 99_00,
        outstandingPaise: 5_00,
        paidSubscriptions: 1,
        byPlan: [],
      };
      let seen: SaasPeriod | undefined;
      try {
        setSaasBillingStatsProvider(async (period) => {
          seen = period;
          return billing;
        });
        expect((await saas()).body.revenue).toEqual(billing);
        expect(seen).toMatchObject({ from: range.from, to: range.to, timezone: 'Asia/Kolkata' });
        expect(seen!.end.getTime()).toBeGreaterThan(seen!.start.getTime());

        setSaasBillingStatsProvider(async () => {
          throw new Error('billing is down');
        });
        const fallback = await saas();
        expect(fallback.status).toBe(200);
        expect(fallback.body.revenue.source).toBe('subscriptions');
      } finally {
        setSaasBillingStatsProvider(null);
      }
    });

    it('exports the institutes table and audits it', async () => {
      const res = await binary(
        `/api/admin/reports/institutes/export?format=csv&from=${range.from}&to=${range.to}`,
      ).set(bearer(t.sa));
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+\.csv"$/);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as Buffer;
      expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(body.toString('utf8')).toContain((await Institute.findByPk(1))!.name);
      const audit = await AuditEvent.findOne({
        where: { action: 'report.saas_exported' },
        order: [['id', 'DESC']],
      });
      expect(audit).toMatchObject({ entityType: 'report', entityId: 'saas-institutes', instituteId: null });
      const denied = await request(app)
        .get('/api/admin/reports/institutes/export?format=csv')
        .set(bearer(t.admin));
      expect(denied.status).toBe(403);
    });
  });
});
