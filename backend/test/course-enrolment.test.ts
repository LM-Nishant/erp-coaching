import request from 'supertest';
import type { Express } from 'express';
import { Op, type InferAttributes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Job } from '../src/infrastructure/jobs/job.model';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { MOCK_SIGNATURE_HEADER, signMockWebhook } from '../src/infrastructure/payment-gateways/mock.gateway';
import { BatchStudent } from '../src/modules/academics/models';
import { AdmissionApplication } from '../src/modules/admissions/models';
import { Branch } from '../src/modules/branches/branch.model';
import { reconcileCourseEnrolment } from '../src/modules/fees/course-enrolment';
import { FeeAccount, FeeCourseEnrolment, PaymentGatewayConfig } from '../src/modules/fees/models';
import { NotificationMessage } from '../src/modules/notifications/models';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { runWithContext } from '../src/shared/context';
import {
  USERS,
  bearer,
  getApp,
  lastOtpFor,
  login,
  newDevice,
  purgeAcademicFixtures,
  purgeRows,
} from './helpers';

const run = Date.now().toString(36).slice(-4).toUpperCase();
let seq = 0;
const mobile = () => `94402${String(seq++).padStart(5, '0')}`;
const WEBHOOK_SECRET = 'whsec_course_enrolment_test';
const SYSTEM = { system: true, instituteId: 1, allowedBranchIds: null };
const BYPASS = { tenantBypass: true } as object;
const PENDING_EVENT = 'fees.course-enrolment-pending';

type Person = { id: number; userId: number; name: string; mobile: string };
type Buyer = Person & { token: string };
type Checkout = { paymentId: number; gatewayOrderId: string; amount: number };

async function otpLogin(m: string) {
  const app = await getApp();
  const device = newDevice();
  const ch = await request(app).post('/api/auth/otp/request').send({ mobile: m, device });
  const res = await request(app)
    .post('/api/auth/otp/verify')
    .send({ challengeId: ch.body.challengeId, code: lastOtpFor(m), device });
  expect(res.body.status).toBe('authenticated');
  return res.body.accessToken as string;
}

describe('online course purchase → admission and batch enrolment', () => {
  let app: Express;
  let admin: string;
  let zenith: string;
  let branchId: number;
  let sessionId: number;
  let webhookPath: string;
  let gatewaySnapshot: InferAttributes<PaymentGatewayConfig>[] = [];
  let jobWatermark = 0;
  let messageWatermark = 0;
  const created = {
    courseIds: [] as number[],
    batchIds: [] as number[],
    structureIds: [] as number[],
    studentIds: [] as number[],
    userIds: [] as number[],
  };
  let courseA: number;
  let a1: number;
  let a2: number;
  let s1: Buyer;
  let s1Checkout: Checkout;

  async function createCourse(tag: string, price = 500_000) {
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: `CE Course ${tag} ${run}`, code: `CE${tag}-${run}`, branchIds: [branchId] });
    expect(course.status).toBe(201);
    created.courseIds.push(course.body.id);
    await createStructure(course.body.id, price);
    return course.body.id as number;
  }
  async function createStructure(courseId: number, price: number, batchId?: number) {
    const st = await request(app)
      .post('/api/fees/structures')
      .set(bearer(admin))
      .send({
        name: `CE ${courseId}${batchId ? `/${batchId}` : ''} ${run}`,
        courseId,
        ...(batchId ? { batchId } : {}),
        components: [{ name: 'Course fee', amount: price }],
        instalmentPlan: { type: 'one_time', count: 1, firstDueDate: '2030-01-10' },
      });
    expect(st.status).toBe(201);
    created.structureIds.push(st.body.id);
  }
  async function createBatch(
    courseId: number,
    tag: string,
    extra: { capacity?: number; startDate?: string; status?: string } = {},
  ) {
    const batch = await request(app)
      .post('/api/academics/batches')
      .set(bearer(admin))
      .send({
        branchId,
        courseId,
        academicSessionId: sessionId,
        name: `CE Batch ${tag}`,
        code: `CE${tag}-${run}`,
        capacity: extra.capacity ?? 5,
        startDate: extra.startDate ?? '2051-04-01',
        ...(extra.status ? { status: extra.status } : {}),
      });
    expect(batch.status).toBe(201);
    created.batchIds.push(batch.body.id);
    return batch.body.id as number;
  }
  async function student(name: string): Promise<Person> {
    const m = mobile();
    const st = await request(app)
      .post('/api/students')
      .set(bearer(admin))
      .send({ name, mobile: m, branchId });
    expect(st.status).toBe(201);
    created.studentIds.push(st.body.id);
    created.userIds.push(st.body.userId);
    return { id: st.body.id, userId: st.body.userId, name, mobile: m };
  }
  const buyer = async (name: string): Promise<Buyer> => {
    const s = await student(name);
    return { ...s, token: await otpLogin(s.mobile) };
  };
  async function enrol(batchId: number, people: Person[]) {
    const res = await request(app)
      .post(`/api/academics/batches/${batchId}/students`)
      .set(bearer(admin))
      .send({ studentUserIds: people.map((p) => p.userId) });
    expect(res.status).toBe(201);
  }
  const quote = (b: Buyer, courseId: number, query: Record<string, unknown> = {}) =>
    request(app).get(`/api/fees/me/courses/${courseId}/quote`).query(query).set(bearer(b.token));
  const checkout = (b: Buyer, courseId: number, body: Record<string, unknown> = {}) =>
    request(app).post(`/api/fees/me/courses/${courseId}/checkout`).set(bearer(b.token)).send(body);
  async function buy(b: Buyer, courseId: number, body: Record<string, unknown> = {}): Promise<Checkout> {
    const res = await checkout(b, courseId, body);
    expect(res.status).toBe(201);
    return res.body;
  }
  async function pay(b: Buyer, c: Checkout) {
    const res = await request(app)
      .post(`/api/fees/me/payments/${c.paymentId}/mock-complete`)
      .set(bearer(b.token))
      .send({ outcome: 'success' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('posted');
    await processDueJobs();
  }
  async function refund(c: Checkout) {
    const res = await request(app)
      .post(`/api/fees/payments/${c.paymentId}/refund`)
      .set(bearer(admin))
      .send({ amount: c.amount, reason: 'Course enrolment test refund' });
    expect(res.status).toBe(201);
    await processDueJobs();
  }
  const enrolmentOf = async (b: Person, courseId: number) =>
    (await FeeCourseEnrolment.findOne({ where: { instituteId: 1, studentId: b.id, courseId } }))!;
  const activeIn = (batchId: number, p: Person) =>
    BatchStudent.count({ where: { instituteId: 1, batchId, studentUserId: p.userId, status: 'active' } });
  const applicationsOf = (p: Person, courseId: number) =>
    AdmissionApplication.findAll({ where: { instituteId: 1, courseId, studentId: p.id } });
  const audits = (action: string, entityId: number) =>
    AuditEvent.findAll({ where: { instituteId: 1, action, entityId: String(entityId) } });
  const pendingNotices = () =>
    NotificationMessage.findAll({
      where: { instituteId: 1, eventKey: PENDING_EVENT, id: { [Op.gt]: messageWatermark } },
    });
  const queue = (query: Record<string, unknown>, token = admin) =>
    request(app).get('/api/fees/course-enrolments').query(query).set(bearer(token));
  const assign = (id: number, batchId: number, token = admin) =>
    request(app).post(`/api/fees/course-enrolments/${id}/assign`).set(bearer(token)).send({ batchId });
  const replay = (accountId: number) => runWithContext(SYSTEM, () => reconcileCourseEnrolment(accountId));

  beforeAll(async () => {
    app = await getApp();
    // Run whatever earlier suites left due, so the jobs processed below are ours.
    await processDueJobs();
    jobWatermark = (await Job.max<number, Job>('id')) ?? 0;
    messageWatermark = (await NotificationMessage.max<number, NotificationMessage>('id', BYPASS)) ?? 0;
    gatewaySnapshot = (await PaymentGatewayConfig.findAll({ where: { instituteId: 1 } })).map((g) =>
      g.get({ plain: true }),
    );
    [admin, zenith] = await Promise.all(
      [USERS.apexAdmin, USERS.zenithAdmin].map(async (u) => (await login(u)).accessToken),
    );
    const gw = await request(app)
      .put('/api/fees/gateways/mock')
      .set(bearer(admin))
      .send({ enabled: true, isDefault: true, webhookSecret: WEBHOOK_SECRET });
    webhookPath = new URL(gw.body.webhookUrl).pathname;
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    const session = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: `CE-${run}`, startDate: '2051-04-01', endDate: '2052-03-31' });
    expect(session.status).toBe(201);
    sessionId = session.body.id;
    courseA = await createCourse('A');
    a1 = await createBatch(courseA, 'A1', { startDate: '2051-04-01' });
    a2 = await createBatch(courseA, 'A2', { startDate: '2051-06-01' });
  });

  afterAll(async () => {
    const applications = await AdmissionApplication.findAll({
      where: {
        instituteId: 1,
        [Op.or]: [{ courseId: created.courseIds }, { studentId: created.studentIds }],
      },
      attributes: ['id'],
    });
    await purgeRows(
      'admission_applications',
      applications.map((a) => a.id),
    );
    await purgeRows('students', created.studentIds);
    await purgeRows('users', created.userIds);
    await purgeRows('fee_structures', created.structureIds);
    await purgeAcademicFixtures({
      batchIds: created.batchIds,
      courseIds: created.courseIds,
      sessionIds: sessionId ? [sessionId] : [],
    });
    const messages = await NotificationMessage.findAll({
      where: { id: { [Op.gt]: messageWatermark } },
      attributes: ['id'],
      ...BYPASS,
    });
    await purgeRows(
      'notification_messages',
      messages.map((m) => m.id),
    );
    await Job.destroy({ where: { id: { [Op.gt]: jobWatermark } } });
    const keep = new Map(gatewaySnapshot.map((g) => [g.id, g]));
    for (const g of await PaymentGatewayConfig.findAll({ where: { instituteId: 1 } })) {
      const saved = keep.get(g.id);
      if (!saved) await g.destroy();
      else {
        const { enabled, isDefault, merchantId, secretEncrypted, keyHint, sandbox } = saved;
        await g.update({ enabled, isDefault, merchantId, secretEncrypted, keyHint, sandbox });
      }
    }
  });

  it('enrols the buyer in the batch chosen at checkout once the payment is captured, exactly once', async () => {
    s1 = await buyer('CE Buyer One');
    const q = await quote(s1, courseA, { batchId: a2 });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({
      payable: 500_000,
      alreadyPaid: false,
      batch: { id: a2, name: 'CE Batch A2', available: true, reason: null },
      enrolment: null,
    });
    expect(q.body.openBatches).toEqual([
      { id: a1, name: 'CE Batch A1', startDate: '2051-04-01', seatsLeft: 5 },
      { id: a2, name: 'CE Batch A2', startDate: '2051-06-01', seatsLeft: 5 },
    ]);

    s1Checkout = await buy(s1, courseA, { batchId: a2 });
    await processDueJobs();
    expect(await FeeCourseEnrolment.count({ where: { instituteId: 1, studentId: s1.id } })).toBe(0);

    const { gatewayOrderId } = s1Checkout;
    const body = JSON.stringify({
      event: 'payment.captured',
      eventId: `evt_${gatewayOrderId}`,
      gatewayOrderId,
      gatewayPaymentId: `pay_${gatewayOrderId}`,
      amountPaise: s1Checkout.amount,
      status: 'success',
    });
    const deliver = async (b = body) =>
      (
        await request(app)
          .post(webhookPath)
          .set('Content-Type', 'application/json')
          .set(MOCK_SIGNATURE_HEADER, signMockWebhook(WEBHOOK_SECRET, b))
          .send(b)
      ).body.outcome;
    expect(await deliver()).toBe('posted');
    await processDueJobs();

    const row = await enrolmentOf(s1, courseA);
    expect(row).toMatchObject({
      status: 'enrolled',
      branchId,
      studentUserId: s1.userId,
      requestedBatchId: a2,
      batchId: a2,
      addedToBatch: true,
      reason: null,
    });
    expect(row.enrolledAt).toBeInstanceOf(Date);
    const [application] = await applicationsOf(s1, courseA);
    expect(application).toMatchObject({ id: row.applicationId, status: 'admitted', batchId: a2 });
    expect(await activeIn(a2, s1)).toBe(1);
    const confirmed = await NotificationMessage.findOne({
      where: { instituteId: 1, userId: s1.userId, eventKey: 'admissions.confirmed', channel: 'in_app' },
    });
    expect(confirmed?.body).toContain('CE Batch A2');
    expect(await audits('fees.course_enrolment.enrolled', row.id)).toHaveLength(1);

    // Webhook replays, a gateway retry with a new event id and a replayed job change nothing.
    expect(await deliver()).toBe('duplicate');
    expect(await deliver(body.replace(`evt_${gatewayOrderId}`, `evt_${gatewayOrderId}_retry`))).toBe(
      'already_processed',
    );
    await processDueJobs();
    expect((await replay(row.accountId))?.id).toBe(row.id);
    expect(await FeeCourseEnrolment.count({ where: { instituteId: 1, studentId: s1.id } })).toBe(1);
    expect(await applicationsOf(s1, courseA)).toHaveLength(1);
    expect(await activeIn(a2, s1)).toBe(1);
    expect(await audits('fees.course_enrolment.enrolled', row.id)).toHaveLength(1);

    const again = await quote(s1, courseA);
    expect(again.body).toMatchObject({
      alreadyPaid: true,
      enrolment: { status: 'enrolled', batchId: a2, batchName: 'CE Batch A2' },
    });
    // A paid course reports that before any batch check.
    const repeat = await checkout(s1, courseA, { batchId: a1 });
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('ALREADY_PAID');
  });

  it('without a choice, completes the open application and uses the earliest open batch with seats', async () => {
    const courseB = await createCourse('B');
    const full = await createBatch(courseB, 'B1', { capacity: 1, startDate: '2051-04-01' });
    await createBatch(courseB, 'B2', { startDate: '2051-04-15', status: 'cancelled' });
    const open = await createBatch(courseB, 'B3', { startDate: '2051-05-01' });
    const later = await createBatch(courseB, 'B4', { startDate: '2051-07-01' });
    await enrol(full, [await student('CE Filler B')]);
    const s2 = await buyer('CE Buyer Two');
    // An application made before the student record existed (e.g. the website admission form).
    const appl = await request(app)
      .post('/api/admissions/applications')
      .set(bearer(admin))
      .send({ name: s2.name, mobile: s2.mobile, branchId, courseId: courseB });
    expect(appl.status).toBe(201);

    const q = await quote(s2, courseB);
    expect(q.body.batch).toBeNull();
    expect(q.body.openBatches.map((b: { id: number }) => b.id)).toEqual([open, later]);
    await pay(s2, await buy(s2, courseB));

    expect(await enrolmentOf(s2, courseB)).toMatchObject({
      status: 'enrolled',
      requestedBatchId: null,
      batchId: open,
      addedToBatch: true,
      reason: null,
      applicationId: appl.body.id,
    });
    const applications = await applicationsOf(s2, courseB);
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({ id: appl.body.id, status: 'admitted', batchId: open });
    expect(await activeIn(open, s2)).toBe(1);
  });

  it('falls back to an open batch when the chosen one filled up before the payment landed', async () => {
    const courseC = await createCourse('C');
    const chosen = await createBatch(courseC, 'C1', { capacity: 1, startDate: '2051-04-01' });
    const other = await createBatch(courseC, 'C2', { startDate: '2051-05-01' });
    const s3 = await buyer('CE Buyer Three');
    const order = await buy(s3, courseC, { batchId: chosen });
    await enrol(chosen, [await student('CE Filler C')]);
    const q = await quote(s3, courseC);
    expect(q.body.batch).toEqual({ id: chosen, name: 'CE Batch C1', available: false, reason: 'full' });

    await pay(s3, order);
    expect(await enrolmentOf(s3, courseC)).toMatchObject({
      status: 'enrolled',
      requestedBatchId: chosen,
      batchId: other,
      reason: 'full',
    });
    expect(await activeIn(chosen, s3)).toBe(0);
    expect(await activeIn(other, s3)).toBe(1);
  });

  it('queues a buyer no batch can take, notifies admins once and lets an admin assign a batch', async () => {
    const courseD = await createCourse('D');
    const s4 = await buyer('CE Buyer Four');
    await pay(s4, await buy(s4, courseD));

    const row = await enrolmentOf(s4, courseD);
    expect(row).toMatchObject({ status: 'awaiting_batch', batchId: null, reason: 'no_open_batch' });
    expect(row.notifiedAt).toBeInstanceOf(Date);
    const [application] = await applicationsOf(s4, courseD);
    expect(application).toMatchObject({ id: row.applicationId, status: 'admitted', batchId: null });

    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(admin));
    const notice = inbox.body.items.find(
      (i: { eventKey: string; title: string }) =>
        i.eventKey === PENDING_EVENT && i.title === 'Assign a batch: CE Buyer Four',
    );
    expect(notice.body).toContain(`CE Course D ${run}`);
    expect(notice.body).toContain('no open batch of the course has free seats');
    const notices = (await pendingNotices()).length;
    expect((await pendingNotices()).some((m) => m.userId === s4.userId)).toBe(false);

    // Replaying the job neither re-notifies nor re-audits while the purchase is still queued.
    expect((await replay(row.accountId))?.status).toBe('awaiting_batch');
    expect(await pendingNotices()).toHaveLength(notices);
    expect(await audits('fees.course_enrolment.awaiting_batch', row.id)).toHaveLength(1);

    const listed = await queue({ status: 'awaiting_batch', courseId: courseD });
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0]).toMatchObject({
      id: row.id,
      accountId: row.accountId,
      studentId: s4.id,
      studentName: 'CE Buyer Four',
      courseName: `CE Course D ${run}`,
      status: 'awaiting_batch',
      reason: 'no_open_batch',
      batchId: null,
    });
    expect((await queue({ search: s4.mobile })).body.items.map((i: { id: number }) => i.id)).toEqual([
      row.id,
    ]);
    expect((await queue({}, s4.token)).status).toBe(403);
    expect((await queue({}, zenith)).body.items.some((i: { id: number }) => i.id === row.id)).toBe(false);
    expect((await assign(row.id, a1, zenith)).status).toBe(404);

    const full = await createBatch(courseD, 'D1', { capacity: 1 });
    await enrol(full, [await student('CE Filler D')]);
    const closed = await createBatch(courseD, 'D2', { status: 'cancelled' });
    const fullRes = await assign(row.id, full);
    expect(fullRes.status).toBe(409);
    expect(fullRes.body.error.code).toBe('BATCH_FULL');
    const closedRes = await assign(row.id, closed);
    expect(closedRes.status).toBe(409);
    expect(closedRes.body.error.code).toBe('BATCH_CLOSED');
    expect((await assign(row.id, a1)).status).toBe(400);
    expect((await assign(row.id, 99_999_999)).status).toBe(404);
    expect((await enrolmentOf(s4, courseD)).status).toBe('awaiting_batch');

    const open = await createBatch(courseD, 'D3', { startDate: '2051-05-01' });
    const assigned = await assign(row.id, open);
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({
      id: row.id,
      status: 'enrolled',
      batchId: open,
      batchName: 'CE Batch D3',
    });
    expect(await activeIn(open, s4)).toBe(1);
    expect(await enrolmentOf(s4, courseD)).toMatchObject({ addedToBatch: true, reason: null });
    expect((await enrolmentOf(s4, courseD)).assignedByUserId).toBeTruthy();
    expect((await applicationsOf(s4, courseD))[0].batchId).toBe(open);
    expect(await audits('fees.course_enrolment.assign', row.id)).toHaveLength(1);
    const confirmed = await NotificationMessage.findOne({
      where: { instituteId: 1, userId: s4.userId, eventKey: 'admissions.confirmed', channel: 'in_app' },
      order: [['id', 'DESC']],
    });
    expect(confirmed?.body).toContain('CE Batch D3');
    const twice = await assign(row.id, open);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('NOT_AWAITING_BATCH');
    expect(await pendingNotices()).toHaveLength(notices);
  });

  it('validates the batch chosen at checkout', async () => {
    const s7 = await buyer('CE Buyer Seven');
    const full = await createBatch(courseA, 'A3', { capacity: 1, startDate: '2051-05-01' });
    await enrol(full, [await student('CE Filler A')]);
    const closed = await createBatch(courseA, 'A4', { status: 'cancelled' });
    const otherCourse = await createCourse('X');
    const foreign = await createBatch(otherCourse, 'X1');

    expect((await quote(s7, courseA, { batchId: full })).body.batch).toEqual({
      id: full,
      name: 'CE Batch A3',
      available: false,
      reason: 'full',
    });
    const fullRes = await checkout(s7, courseA, { batchId: full });
    expect(fullRes.status).toBe(409);
    expect(fullRes.body.error.code).toBe('BATCH_FULL');
    const closedRes = await checkout(s7, courseA, { batchId: closed });
    expect(closedRes.status).toBe(409);
    expect(closedRes.body.error.code).toBe('BATCH_CLOSED');
    expect((await checkout(s7, courseA, { batchId: foreign })).status).toBe(400);
    expect((await checkout(s7, courseA, { batchId: 99_999_999 })).status).toBe(404);
    expect(await FeeAccount.count({ where: { instituteId: 1, studentId: s7.id } })).toBe(0);

    // An unpaid purchase may switch batch.
    await buy(s7, courseA, { batchId: a1 });
    await buy(s7, courseA, { batchId: a2 });
    expect((await quote(s7, courseA)).body.batch).toMatchObject({ id: a2, available: true });
    expect((await FeeAccount.findOne({ where: { instituteId: 1, studentId: s7.id } }))?.batchId).toBe(a2);

    // A batch-specific price ties the purchase to its batch.
    const courseF = await createCourse('F');
    const f1 = await createBatch(courseF, 'F1');
    const f2 = await createBatch(courseF, 'F2');
    await createStructure(courseF, 400_000, f1);
    expect((await quote(s7, courseF, { batchId: f1 })).body.amount).toBe(400_000);
    expect((await buy(s7, courseF, { batchId: f1 })).amount).toBe(400_000);
    const moved = await checkout(s7, courseF, { batchId: f2 });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('PURCHASE_BATCH_FIXED');
  });

  it('a refund takes the buyer out of the batch the purchase put them in, and a re-purchase brings them back', async () => {
    await refund(s1Checkout);
    const row = await enrolmentOf(s1, courseA);
    expect(row).toMatchObject({ status: 'revoked', batchId: a2 });
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(await activeIn(a2, s1)).toBe(0);
    expect(
      await BatchStudent.count({
        where: { instituteId: 1, batchId: a2, studentUserId: s1.userId, status: 'left' },
      }),
    ).toBe(1);
    expect((await applicationsOf(s1, courseA))[0].status).toBe('admitted');
    const [revoked] = await audits('fees.course_enrolment.revoked', row.id);
    expect(revoked.metadata).toMatchObject({ leftBatch: true });
    expect((await quote(s1, courseA)).body).toMatchObject({
      alreadyPaid: false,
      enrolment: { status: 'revoked' },
    });
    expect((await replay(row.accountId))?.status).toBe('revoked');
    expect(await audits('fees.course_enrolment.revoked', row.id)).toHaveLength(1);

    await pay(s1, await buy(s1, courseA, { batchId: a2 }));
    expect(await enrolmentOf(s1, courseA)).toMatchObject({ id: row.id, status: 'enrolled', batchId: a2 });
    expect(await activeIn(a2, s1)).toBe(1);
    expect(await applicationsOf(s1, courseA)).toHaveLength(1);
  });

  it('a refund leaves a batch the student was already in, and just closes a queued purchase', async () => {
    const s6 = await buyer('CE Buyer Six');
    await enrol(a1, [s6]);
    const order = await buy(s6, courseA, { batchId: a2 });
    await pay(s6, order);
    expect(await enrolmentOf(s6, courseA)).toMatchObject({
      status: 'enrolled',
      requestedBatchId: a2,
      batchId: a1,
      addedToBatch: false,
    });
    expect(await activeIn(a2, s6)).toBe(0);
    await refund(order);
    expect((await enrolmentOf(s6, courseA)).status).toBe('revoked');
    expect(await activeIn(a1, s6)).toBe(1);

    const courseE = await createCourse('E');
    const s5 = await buyer('CE Buyer Five');
    const queued = await buy(s5, courseE);
    await pay(s5, queued);
    const row = await enrolmentOf(s5, courseE);
    expect(row.status).toBe('awaiting_batch');
    await refund(queued);
    expect(await enrolmentOf(s5, courseE)).toMatchObject({ status: 'revoked', batchId: null });
    expect((await queue({ status: 'awaiting_batch', courseId: courseE })).body.total).toBe(0);
    const late = await assign(row.id, await createBatch(courseE, 'E1'));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('NOT_AWAITING_BATCH');
  });
});
