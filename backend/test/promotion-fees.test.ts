import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAN_MODULE_KEYS, type PromotionFeeOptions, type PromotionResult } from '@erp/shared';
import { Branch } from '../src/modules/branches/branch.model';
import { BatchStudent, setPromotionFeeProvider } from '../src/modules/academics/api';
import { StudentPromotion } from '../src/modules/academics/models';
import { FeeAccount, FeeInstalment } from '../src/modules/fees/models';
import { promotionFeeProvider, promotionStructureRank } from '../src/modules/fees/promotion-fees';
import { getActiveSubscription } from '../src/modules/subscriptions/subscription.service';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { DEMO_PASSWORD, USERS, bearer, getApp, idWatermarks, login, purgeCreatedSince } from './helpers';

let seq = 0;
const run = Date.now().toString(36).slice(-5).toUpperCase();
const mobile = () => `957${String(Date.now() % 10000).padStart(4, '0')}${String(seq++).padStart(3, '0')}`;

/** Everything this file creates, purged afterwards in this order (whole journals first). */
const CREATED_TABLES = [
  'fee_ledger_entries',
  'fee_accounts',
  'student_promotions',
  'batch_students',
  'students',
  'users',
  'roles',
  'fee_structures',
  'batches',
  'courses',
  'academic_sessions',
  'notification_messages',
  'jobs',
] as const;
let watermarks: Record<string, number>;

beforeAll(async () => {
  await getApp();
  watermarks = await idWatermarks(CREATED_TABLES);
});

afterAll(async () => {
  setPromotionFeeProvider(promotionFeeProvider);
  await purgeCreatedSince(watermarks);
});

describe('promotionStructureRank', () => {
  const target = { batchId: 10, branchId: 1, courseId: 5, academicSessionId: 7 };
  const rank = (s: Partial<Parameters<typeof promotionStructureRank>[0]>) =>
    promotionStructureRank(
      { kind: 'course', batchId: null, courseId: 5, branchId: null, academicSessionId: null, ...s },
      target,
    );

  it('prefers the batch, then the new session (branch first), then structures without a session', () => {
    expect(rank({ batchId: 10, branchId: 1, academicSessionId: 7 })).toBe(0);
    expect(rank({ branchId: 1, academicSessionId: 7 })).toBe(1);
    expect(rank({ academicSessionId: 7 })).toBe(2);
    expect(rank({ branchId: 1 })).toBe(3);
    expect(rank({})).toBe(4);
  });

  it("never applies another batch, session, branch or course, or a subject's structure", () => {
    expect(rank({ batchId: 11, branchId: 1, academicSessionId: 7 })).toBeUndefined();
    expect(rank({ academicSessionId: 6 })).toBeUndefined();
    expect(rank({ branchId: 2, academicSessionId: 7 })).toBeUndefined();
    expect(rank({ courseId: 6 })).toBeUndefined();
    expect(rank({ kind: 'subject' })).toBeUndefined();
  });
});

describe('academic promotion applies new-session fees', () => {
  type Person = { id: number; userId: number; name: string };
  type Structure = { id: number; familyId: number };
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let teacher: string;
  let zenith: string;
  /** academics.view + academics.configure, without fees.create. */
  let promoter: string;
  /** academics.view + academics.configure + fees.create, in branch A only. */
  let branchPromoter: string;
  let branchA: number;
  let branchB: number;
  const ids: Record<string, number> = {};
  const st: Record<string, Structure> = {};
  const people: Record<string, Person> = {};

  const post = (token: string, path: string, body: object) =>
    request(app).post(`/api${path}`).set(bearer(token)).send(body);
  const created = async (token: string, path: string, body: object) => {
    const res = await post(token, path, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };
  const newStudent = async (name: string, branchId = branchA): Promise<Person> => ({
    ...(await created(admin, '/students', { name, mobile: mobile(), branchId })),
    name,
  });
  const enrol = (batchId: number, ...students: Person[]) =>
    created(admin, `/academics/batches/${batchId}/students`, {
      studentUserIds: students.map((s) => s.userId),
    });
  const promote = (token: string, body: object) =>
    post(token, '/academics/promotions', { fromBatchId: ids.from, toBatchId: ids.to, ...body });
  const options = (token: string, batchId = ids.to) =>
    request(app).get(`/api/academics/batches/${batchId}/promotion-fees`).set(bearer(token));
  const structure = (name: string, extra: object = {}): Promise<Structure> =>
    created(admin, '/fees/structures', {
      name: `${name} ${run}`,
      courseId: ids.course,
      components: [{ name: 'Tuition', amount: 1_200_000 }],
      instalmentPlan: { type: 'quarterly', count: 4, firstDueDate: '2041-04-10' },
      ...extra,
    });
  const accountsFor = (p: Person) =>
    FeeAccount.findAll({
      where: { instituteId: 1, studentId: p.id, batchId: ids.to },
      order: [['id', 'ASC']],
    });
  const dueDates = async (accountId: number) =>
    (await FeeInstalment.findAll({ where: { instituteId: 1, accountId }, order: [['seq', 'ASC']] })).map(
      (i) => [i.dueDate, i.amount],
    );
  const activeIn = async (batchId: number, p: Person) =>
    (await BatchStudent.count({
      where: { instituteId: 1, batchId, studentUserId: p.userId, status: 'active' },
    })) === 1;
  const promotionsOf = (p: Person) =>
    StudentPromotion.count({ where: { instituteId: 1, studentUserId: p.userId } });
  const lastAudit = async (action: string) =>
    (await AuditEvent.findOne({ where: { instituteId: 1, action }, order: [['id', 'DESC']] }))!;

  beforeAll(async () => {
    app = await getApp();
    [admin, teacher, zenith] = await Promise.all(
      [USERS.apexAdmin, USERS.apexTeacher, USERS.zenithAdmin].map(async (u) => (await login(u)).accessToken),
    );
    const branches = await Branch.findAll({ where: { instituteId: 1 }, order: [['id', 'ASC']] });
    [branchA, branchB] = branches.map((b) => b.id);

    const staff = async (name: string, permissions: string[], branchId: number | null) => {
      const role = await created(admin, '/roles', { name: `${name} ${run}`, permissions });
      const user = { mobile: mobile(), password: DEMO_PASSWORD };
      await created(admin, '/users', {
        name,
        ...user,
        roles: [{ roleId: role.id, branchId }],
        ...(branchId && { branchIds: [branchId] }),
      });
      return (await login(user)).accessToken;
    };
    promoter = await staff('Promoter', ['academics.view', 'academics.configure'], null);
    branchPromoter = await staff(
      'Branch promoter',
      ['academics.view', 'academics.configure', 'fees.create'],
      branchA,
    );

    const session = async (startYear: number) =>
      (
        await created(admin, '/academics/sessions', {
          name: `PF ${startYear} ${run}`,
          startDate: `${startYear}-04-01`,
          endDate: `${startYear + 1}-03-31`,
        })
      ).id as number;
    ids.s1 = await session(2040);
    ids.s2 = await session(2041);
    const course = async (code: string, branchIds: number[]) =>
      (
        await created(admin, '/academics/courses', {
          name: `Promotion fees ${code} ${run}`,
          code: `${code}-${run}`,
          branchIds,
        })
      ).id as number;
    ids.course = await course('PF', [branchA, branchB]);
    ids.unpricedCourse = await course('PFU', [branchA]);
    const batch = async (courseId: number, sessionId: number, code: string) =>
      (
        await created(admin, '/academics/batches', {
          branchId: branchA,
          courseId,
          academicSessionId: sessionId,
          name: `Promotion fees ${code}`,
          code: `${code}-${run}`,
          capacity: 30,
          startDate: sessionId === ids.s1 ? '2040-04-01' : '2041-04-01',
        })
      ).id as number;
    ids.from = await batch(ids.course, ids.s1, 'PF-Y1');
    ids.to = await batch(ids.course, ids.s2, 'PF-Y2');
    ids.unpricedFrom = await batch(ids.unpricedCourse, ids.s1, 'PFU-Y1');
    ids.unpricedTo = await batch(ids.unpricedCourse, ids.s2, 'PFU-Y2');

    st.session = await structure('New session', { academicSessionId: ids.s2 });
    st.anySession = await structure('Any session', {
      components: [{ name: 'Tuition', amount: 800_000 }],
      instalmentPlan: { type: 'one_time', firstDueDate: '2041-04-15' },
    });
    st.oldSession = await structure('Old session', { academicSessionId: ids.s1 });
    st.otherBranch = await structure('Branch B', { branchId: branchB, academicSessionId: ids.s2 });
    st.draft = await structure('Draft', { academicSessionId: ids.s2, status: 'draft' });
  });

  it('lists the active structures that can bill the new session, best first', async () => {
    const res = await options(admin);
    expect(res.status).toBe(200);
    const body = res.body as PromotionFeeOptions;
    expect(body).toMatchObject({ available: true, defaultStructureId: st.session.id });
    expect(body.structures.map((s) => s.id)).toEqual([st.session.id, st.anySession.id]);
    expect(body.structures[0]).toMatchObject({
      name: `New session ${run}`,
      total: 1_200_000,
      academicSessionId: ids.s2,
      instalmentPlan: { type: 'quarterly', count: 4 },
    });

    expect((await options(zenith)).status).toBe(404);
    expect((await options(teacher)).status).toBe(403);
    const denied = await options(promoter);
    expect([denied.status, denied.body.error.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('bills only the students it promotes, in the promotion transaction', async () => {
    Object.assign(people, {
      p1: await newStudent('Promoted One'),
      p2: await newStudent('Promoted Two'),
      p3: await newStudent('Promoted Later'),
      e1: await newStudent('Already In Target'),
    });
    const { p1, p2, p3, e1 } = people;
    await enrol(ids.from, p1, p2, p3);
    await enrol(ids.to, e1);

    const res = await promote(admin, { studentUserIds: [p1.userId, p2.userId], fees: {} });
    expect(res.status).toBe(200);
    const body = res.body as PromotionResult;
    expect(body).toMatchObject({
      promoted: 2,
      skipped: [],
      fees: { structureId: st.session.id, structureName: `New session ${run}`, created: 2, skipped: 0 },
    });
    expect(body.fees!.results).toHaveLength(2);
    expect(body.fees!.results).toEqual(
      expect.arrayContaining(
        [p1, p2].map((p) => ({
          studentUserId: p.userId,
          studentName: p.name,
          status: 'created',
          accountId: expect.any(Number),
        })),
      ),
    );

    for (const p of [p1, p2]) {
      const accounts = await accountsFor(p);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: body.fees!.results.find((r) => r.studentUserId === p.userId)!.accountId,
        source: 'promotion',
        sourceRef: `batch:${ids.to}:${st.session.familyId}:${p.id}`,
        structureId: st.session.id,
        academicSessionId: ids.s2,
        branchId: branchA,
        studentUserId: p.userId,
        gross: 1_200_000,
      });
      expect(await dueDates(accounts[0].id)).toEqual([
        ['2041-04-10', 300_000],
        ['2041-07-10', 300_000],
        ['2041-10-10', 300_000],
        ['2042-01-10', 300_000],
      ]);
    }
    // Neither the student already in the target batch nor the one left behind is billed.
    expect(await accountsFor(e1)).toEqual([]);
    expect(await accountsFor(p3)).toEqual([]);
    expect(await activeIn(ids.from, p3)).toBe(true);
    const tb = await request(app).get('/api/fees/ledger/trial-balance').set(bearer(admin));
    expect(tb.body.balanced).toBe(true);

    expect((await lastAudit('academics.students_promoted')).metadata).toMatchObject({
      toBatchId: ids.to,
      fees: { structureId: st.session.id, created: 2, skipped: 0 },
    });
    const feeAudit = await lastAudit('fees.account.generate-promotion');
    expect(feeAudit).toMatchObject({ entityType: 'batch', entityId: String(ids.to) });
    expect(feeAudit.metadata).toMatchObject({
      fromBatchId: ids.from,
      structureId: st.session.id,
      created: 2,
    });
    expect(JSON.stringify(feeAudit.metadata)).not.toContain(p1.name);

    // Repeating the request promotes and bills nobody again.
    const again = await promote(admin, { studentUserIds: [p1.userId, p2.userId], fees: {} });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ promoted: 0, fees: { created: 0, skipped: 0, results: [] } });
    expect(again.body.skipped).toHaveLength(2);
    for (const p of [p1, p2]) expect(await accountsFor(p)).toHaveLength(1);
  });

  it('applies the chosen structure and first due date; "generate for batch" then skips promoted students', async () => {
    const { p1, p2, p3, e1 } = people;
    const res = await promote(admin, {
      studentUserIds: [p3.userId],
      fees: { structureId: st.anySession.id, firstDueDate: '2041-06-15' },
    });
    expect(res.status).toBe(200);
    expect(res.body.fees).toMatchObject({ structureId: st.anySession.id, created: 1, skipped: 0 });
    const [account] = await accountsFor(p3);
    expect(account).toMatchObject({ structureId: st.anySession.id, source: 'promotion', gross: 800_000 });
    expect(await dueDates(account.id)).toEqual([['2041-06-15', 800_000]]);

    // Same key as the promotion: p1 and p2 aren't billed twice; e1 and p3 (other structure) are billed.
    const generated = await post(admin, '/fees/accounts/generate-batch', {
      batchId: ids.to,
      structureId: st.session.id,
    });
    expect(generated.status).toBe(200);
    expect(generated.body).toMatchObject({ created: 2, skipped: 2 });
    for (const p of [p1, p2, e1]) expect(await accountsFor(p)).toHaveLength(1);
    expect(await accountsFor(p3)).toHaveLength(2);
  });

  it('skips a student already billed for the target batch', async () => {
    const { e1 } = people;
    const [billed] = await accountsFor(e1);
    const left = await request(app)
      .delete(`/api/academics/batches/${ids.to}/students/${e1.userId}`)
      .set(bearer(admin));
    expect(left.status).toBeLessThan(300);
    await enrol(ids.from, e1);

    const res = await promote(admin, { studentUserIds: [e1.userId], fees: { structureId: st.session.id } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ promoted: 1, fees: { created: 0, skipped: 1 } });
    expect(res.body.fees.results).toEqual([
      {
        studentUserId: e1.userId,
        studentName: e1.name,
        status: 'skipped',
        reason: 'Already billed for this batch',
        accountId: billed.id,
      },
    ]);
    expect(await accountsFor(e1)).toHaveLength(1);
    expect(await activeIn(ids.to, e1)).toBe(true);
  });

  it('needs fees.create to apply fees, and then changes nothing', async () => {
    const p4 = await newStudent('Needs Permission');
    await enrol(ids.from, p4);
    const denied = await promote(promoter, { studentUserIds: [p4.userId], fees: {} });
    expect([denied.status, denied.body.error.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(await activeIn(ids.from, p4)).toBe(true);
    expect(await promotionsOf(p4)).toBe(0);

    // Without fees, promotion still only needs academics.configure, and bills nobody.
    const plain = await promote(promoter, { studentUserIds: [p4.userId] });
    expect(plain.status).toBe(200);
    expect(plain.body).toEqual({ promoted: 1, skipped: [] });
    expect(await activeIn(ids.to, p4)).toBe(true);
    expect(await accountsFor(p4)).toEqual([]);
  });

  it('rejects a structure that cannot bill the target batch before promoting anyone', async () => {
    const p5 = await newStudent('Not Promoted');
    await enrol(ids.from, p5);
    const zenithCourse = await created(zenith, '/academics/courses', {
      name: `Zenith promotion ${run}`,
      code: `ZPF-${run}`,
    });
    const zenithStructure = await created(zenith, '/fees/structures', {
      name: `Zenith ${run}`,
      courseId: zenithCourse.id,
      components: [{ name: 'Tuition', amount: 500_000 }],
      instalmentPlan: { type: 'one_time', firstDueDate: '2041-04-10' },
    });
    const attempt = (fees: object) => promote(admin, { studentUserIds: [p5.userId], fees });
    const cases: [object, number, string?][] = [
      [{ structureId: zenithStructure.id }, 404],
      [{ structureId: st.draft.id }, 409, 'STRUCTURE_INACTIVE'],
      [{ structureId: st.oldSession.id }, 400],
      [{ structureId: st.otherBranch.id }, 400],
      [{ firstDueDate: '15-06-2041' }, 422],
    ];
    for (const [fees, status, code] of cases) {
      const res = await attempt(fees);
      expect([res.status, code && res.body.error.code], JSON.stringify(fees)).toEqual([status, code]);
    }
    // Another institute can't promote (or bill) this institute's batches.
    expect((await promote(zenith, { fees: {} })).status).toBe(404);
    expect(await activeIn(ids.from, p5)).toBe(true);
    expect(await promotionsOf(p5)).toBe(0);
    expect(await accountsFor(p5)).toEqual([]);

    const p6 = await newStudent('Unpriced Course');
    await enrol(ids.unpricedFrom, p6);
    const unpriced = await post(admin, '/academics/promotions', {
      fromBatchId: ids.unpricedFrom,
      toBatchId: ids.unpricedTo,
      fees: {},
    });
    expect(unpriced.status).toBe(400);
    expect(unpriced.body.error.message).toBe('No active fee structure applies to the target batch');
    expect(await activeIn(ids.unpricedFrom, p6)).toBe(true);
  });

  it('promotes but skips students it may not bill, saying why', async () => {
    const q1 = await newStudent('Branch B One', branchB);
    const q2 = await newStudent('Branch B Two', branchB);
    await enrol(ids.from, q1, q2);

    const outside = await promote(branchPromoter, { studentUserIds: [q1.userId], fees: {} });
    expect(outside.status).toBe(200);
    expect(outside.body).toMatchObject({ promoted: 1, fees: { structureId: st.session.id, created: 0 } });
    expect(outside.body.fees.results).toEqual([
      {
        studentUserId: q1.userId,
        studentName: q1.name,
        status: 'skipped',
        reason: "The student's branch is outside your access",
      },
    ]);

    st.branchA = await structure('Branch A', { branchId: branchA, academicSessionId: ids.s2 });
    expect((await options(admin)).body.defaultStructureId).toBe(st.branchA.id);
    const otherBranch = await promote(admin, { studentUserIds: [q2.userId], fees: {} });
    expect(otherBranch.status).toBe(200);
    expect(otherBranch.body.fees).toMatchObject({ structureId: st.branchA.id, created: 0, skipped: 1 });
    expect(otherBranch.body.fees.results[0].reason).toBe(
      "The fee structure is for another branch than the student's",
    );
    expect(await accountsFor(q1)).toEqual([]);
    expect(await accountsFor(q2)).toEqual([]);
  });

  it('offers no fees when the plan lacks the fees module or no provider is registered', async () => {
    const p7 = await newStudent('Fees Off');
    await enrol(ids.from, p7);
    const disabled = async () => {
      expect((await options(admin)).body).toEqual({
        available: false,
        defaultStructureId: null,
        structures: [],
      });
      const res = await promote(admin, { studentUserIds: [p7.userId], fees: {} });
      expect([res.status, res.body.error.code]).toEqual([403, 'MODULE_DISABLED']);
    };

    const sub = (await getActiveSubscription(1))!;
    const saved = sub.limitOverrides;
    await sub.update({
      limitOverrides: {
        ...((saved as Record<string, unknown> | null) ?? {}),
        enabledModules: PLAN_MODULE_KEYS.filter((k) => k !== 'fees'),
      },
    });
    try {
      await disabled();
    } finally {
      await sub.update({ limitOverrides: saved as never });
    }
    setPromotionFeeProvider(null);
    try {
      await disabled();
    } finally {
      setPromotionFeeProvider(promotionFeeProvider);
    }
    expect(await activeIn(ids.from, p7)).toBe(true);
    expect((await options(admin)).body.available).toBe(true);
  });
});
