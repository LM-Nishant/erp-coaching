import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import { BatchStudent } from '../src/modules/academics/models';
import { AdmissionApplication } from '../src/modules/admissions/models';
import { Branch } from '../src/modules/branches/branch.model';
import { User } from '../src/modules/users/user.model';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { USERS, bearer, getApp, login, purgeAcademicFixtures, purgeRows } from './helpers';

const PREFIX = '933';
let seq = 0;
const mobile = () => `${PREFIX}${String(seq++).padStart(7, '0')}`;

describe('admissions', () => {
  let apex: string;
  let zenith: string;
  let branchAdminId: number;
  // Academic fixtures in apex: one session; courses A and B (both branches) plus one for the waitlist test.
  const run = Date.now().toString(36).slice(-5).toUpperCase();
  let kothrud: number;
  let baner: number;
  let sessionId: number;
  let waitlistCourse: number;
  let courseA: number;
  let courseB: number;
  let smallBatch: number; // course A, Kothrud, one seat
  let roomyBatch: number; // course A, Kothrud
  let cancelledBatch: number; // course A, Kothrud
  let otherBatch: number; // course B, Kothrud

  beforeAll(async () => {
    const app = await getApp();
    apex = (await login(USERS.apexAdmin)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    branchAdminId = (await User.findOne({ where: { mobile: USERS.apexBranchAdmin.mobile } }))!.id;
    [kothrud, baner] = (
      await Branch.findAll({ where: { instituteId: 1 }, order: [['id', 'ASC']], attributes: ['id'] })
    ).map((b) => b.id);

    const course = async (name: string) => {
      const res = await request(app)
        .post('/api/academics/courses')
        .set(bearer(apex))
        .send({
          name: `${name} ${run}`,
          code: `ADM-${name.replace(/\W/g, '')}-${run}`,
          branchIds: [kothrud, baner],
        });
      expect(res.status).toBe(201);
      return res.body.id as number;
    };
    [waitlistCourse, courseA, courseB] = [
      await course('Waitlist'),
      await course('Course A'),
      await course('Course B'),
    ];
    const session = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(apex))
      .send({ name: `ADM-${run}`, startDate: '2063-04-01', endDate: '2064-03-31' });
    expect(session.status).toBe(201);
    sessionId = session.body.id;
    const batch = async (name: string, courseId: number, capacity: number, status = 'planned') => {
      const res = await request(app)
        .post('/api/academics/batches')
        .set(bearer(apex))
        .send({
          branchId: kothrud,
          courseId,
          academicSessionId: sessionId,
          name: `${name} ${run}`,
          code: `ADM-${name}-${run}`,
          capacity,
          startDate: '2063-04-01',
          status,
        });
      expect(res.status).toBe(201);
      return res.body.id as number;
    };
    smallBatch = await batch('Small', courseA, 1);
    roomyBatch = await batch('Roomy', courseA, 5);
    cancelledBatch = await batch('Cancelled', courseA, 5, 'cancelled');
    otherBatch = await batch('Other', courseB, 5);
  });

  afterAll(async () => {
    const mine = async (table: string) => {
      const [rows] = await getSequelize().query(`SELECT id FROM \`${table}\` WHERE mobile LIKE ?`, {
        replacements: [`${PREFIX}%`],
      });
      return (rows as { id: number }[]).map((r) => r.id);
    };
    for (const table of ['admission_applications', 'enquiries', 'students', 'users'])
      await purgeRows(table, await mine(table));
    await purgeAcademicFixtures({
      batchIds: [smallBatch, roomyBatch, cancelledBatch, otherBatch],
      courseIds: [waitlistCourse, courseA, courseB],
      sessionIds: [sessionId],
    });
  });

  it('runs the enquiry pipeline: duplicates warning, follow-up reminder, conversion', async () => {
    const app = await getApp();
    const m = mobile();
    const e = await request(app).post('/api/admissions/enquiries').set(bearer(apex)).send({
      name: 'Enq Person',
      mobile: m,
      source: 'website',
      counsellorUserId: branchAdminId,
      courseInterest: 'JEE',
    });
    expect(e.status).toBe(201);
    expect(e.body.status).toBe('new');
    expect(e.body.duplicates).toEqual([]);

    const again = await request(app)
      .post('/api/admissions/enquiries')
      .set(bearer(apex))
      .send({ name: 'Enq Person', mobile: m });
    expect(again.body.duplicates[0]).toMatchObject({ kind: 'enquiry', id: e.body.id });

    expect(
      (
        await request(app)
          .post('/api/admissions/enquiries')
          .set(bearer(apex))
          .send({ name: 'Bad Src', mobile: mobile(), source: 'pigeon' })
      ).status,
    ).toBe(400);

    const at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const fu = await request(app)
      .post(`/api/admissions/enquiries/${e.body.id}/follow-ups`)
      .set(bearer(apex))
      .send({ note: 'Call about fees', scheduledAt: at });
    expect(fu.status).toBe(201);
    const detail = await request(app).get(`/api/admissions/enquiries/${e.body.id}`).set(bearer(apex));
    expect(detail.body.status).toBe('follow_up');
    expect(detail.body.nextFollowUpAt).toBeTruthy();

    // Reminder is due (follow-up is within the 30-minute lead time) → SMS to the counsellor.
    await processDueJobs();
    await processDueJobs(); // notify() queues the SMS as a notifications.deliver job
    const sms = consoleOutbox.find(
      (msg) => msg.data?.eventKey === 'admissions.follow-up-due' && msg.to === USERS.apexBranchAdmin.mobile,
    );
    expect(sms?.body).toContain('Enq Person');

    const conv = await request(app)
      .post(`/api/admissions/enquiries/${e.body.id}/convert`)
      .set(bearer(apex))
      .send({});
    expect(conv.status).toBe(201);
    expect(conv.body.admissionNumber).toMatch(/^APEX\//);
    const after = await request(app).get(`/api/admissions/enquiries/${e.body.id}`).set(bearer(apex));
    expect(after.body).toMatchObject({ status: 'converted', studentId: conv.body.id });
    expect(
      (await request(app).post(`/api/admissions/enquiries/${e.body.id}/convert`).set(bearer(apex)).send({}))
        .status,
    ).toBe(409);

    const summary = await request(app).get('/api/admissions/enquiries/summary').set(bearer(apex));
    expect(summary.status).toBe(200);
  });

  it('validates custom fields against the institute form', async () => {
    const app = await getApp();
    const form = await request(app)
      .post('/api/admissions/forms')
      .set(bearer(zenith))
      .send({
        name: 'Enquiry form',
        purpose: 'enquiry',
        fields: [
          {
            key: 'target_exam',
            label: 'Target exam',
            type: 'select',
            required: true,
            options: ['JEE', 'NEET'],
          },
          { key: 'school', label: 'School', type: 'text' },
        ],
      });
    expect(form.status).toBe(201);
    const active = await request(app).get('/api/admissions/forms/active?purpose=enquiry').set(bearer(zenith));
    expect(active.body.id).toBe(form.body.id);

    const missing = await request(app)
      .post('/api/admissions/enquiries')
      .set(bearer(zenith))
      .send({ name: 'Form Kid', mobile: mobile() });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].path).toBe('customFields.target_exam');
    const badOption = await request(app)
      .post('/api/admissions/enquiries')
      .set(bearer(zenith))
      .send({ name: 'Form Kid', mobile: mobile(), customFields: { target_exam: 'CAT' } });
    expect(badOption.status).toBe(422);
    const ok = await request(app)
      .post('/api/admissions/enquiries')
      .set(bearer(zenith))
      .send({
        name: 'Form Kid',
        mobile: mobile(),
        customFields: { target_exam: 'NEET', school: 'KV', junk: 1 },
      });
    expect(ok.status).toBe(201);
    expect(ok.body.customFields).toEqual({ target_exam: 'NEET', school: 'KV' });

    // Apex is unaffected by Zenith's form and cannot see or edit it.
    expect(
      (
        await request(app)
          .post('/api/admissions/enquiries')
          .set(bearer(apex))
          .send({ name: 'Free Kid', mobile: mobile() })
      ).status,
    ).toBe(201);
    expect((await request(app).get(`/api/admissions/forms/${form.body.id}`).set(bearer(apex))).status).toBe(
      404,
    );
    expect(
      (await request(app).delete(`/api/admissions/forms/${form.body.id}`).set(bearer(zenith))).status,
    ).toBe(204);
  });

  it('manages the waiting list and admits from it', async () => {
    const app = await getApp();
    const courseId = waitlistCourse;
    const apps: { id: number; waitlistPosition: number }[] = [];
    for (const name of ['Wait One', 'Wait Two', 'Wait Three']) {
      const r = await request(app)
        .post('/api/admissions/applications')
        .set(bearer(apex))
        .send({ name, mobile: mobile(), courseId, waitlist: true });
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('waitlisted');
      apps.push(r.body);
    }
    expect(apps.map((a) => a.waitlistPosition)).toEqual([1, 2, 3]);

    const moved = await request(app)
      .post(`/api/admissions/applications/${apps[2].id}/move`)
      .set(bearer(apex))
      .send({ position: 1 });
    expect(moved.body.waitlistPosition).toBe(1);

    const admitted = await request(app)
      .post(`/api/admissions/applications/${apps[0].id}/admit`)
      .set(bearer(apex))
      .send({});
    expect(admitted.status).toBe(201);
    expect(admitted.body.application.status).toBe('admitted');
    const a0 = await request(app).get(`/api/admissions/applications/${apps[0].id}`).set(bearer(apex));
    expect(a0.body).toMatchObject({
      status: 'admitted',
      studentId: admitted.body.student.id,
      waitlistPosition: null,
    });
    const profile = await request(app).get(`/api/students/${admitted.body.student.id}`).set(bearer(apex));
    expect(profile.body.history.map((h: { eventType: string }) => h.eventType)).toContain(
      'admitted_for_course',
    );

    const list = await request(app).get(`/api/admissions/applications?status=waitlisted`).set(bearer(apex));
    const positions = Object.fromEntries(
      list.body.items.map((a: { id: number; waitlistPosition: number }) => [a.id, a.waitlistPosition]),
    );
    expect(positions[apps[2].id]).toBe(1);
    expect(positions[apps[1].id]).toBe(2);

    const rej = await request(app)
      .post(`/api/admissions/applications/${apps[1].id}/reject`)
      .set(bearer(apex))
      .send({ remarks: 'No seats' });
    expect(rej.body.status).toBe('rejected');
    expect(
      (await request(app).post(`/api/admissions/applications/${apps[1].id}/admit`).set(bearer(apex)).send({}))
        .status,
    ).toBe(409);
  });

  it('enforces permissions and tenant isolation', async () => {
    const app = await getApp();
    const teacher = (await login(USERS.apexTeacher)).accessToken;
    expect((await request(app).get('/api/admissions/enquiries').set(bearer(teacher))).status).toBe(403);
    const z = await request(app)
      .post('/api/admissions/enquiries')
      .set(bearer(zenith))
      .send({ name: 'Zen Enq', mobile: mobile(), customFields: {} });
    expect(z.status).toBe(201);
    expect((await request(app).get(`/api/admissions/enquiries/${z.body.id}`).set(bearer(apex))).status).toBe(
      404,
    );
    expect(
      (
        await request(app)
          .patch(`/api/admissions/enquiries/${z.body.id}`)
          .set(bearer(apex))
          .send({ status: 'lost' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).post(`/api/admissions/enquiries/${z.body.id}/convert`).set(bearer(apex)).send({}))
        .status,
    ).toBe(404);
    const list = await request(app).get('/api/admissions/enquiries?pageSize=200').set(bearer(apex));
    expect(list.body.items.some((e: { id: number }) => e.id === z.body.id)).toBe(false);
    // Counsellors must belong to the institute.
    const zAdminId = (await User.findOne({ where: { mobile: USERS.zenithAdmin.mobile } }))!.id;
    expect(
      (
        await request(app)
          .post('/api/admissions/enquiries')
          .set(bearer(apex))
          .send({ name: 'Bad Counsellor', mobile: mobile(), counsellorUserId: zAdminId })
      ).status,
    ).toBe(400);
  });

  const apply = async (body: Record<string, unknown>) => {
    const res = await request(await getApp())
      .post('/api/admissions/applications')
      .set(bearer(apex))
      .send({ name: 'Edit Kid', mobile: mobile(), branchId: kothrud, ...body });
    expect(res.status).toBe(201);
    return res.body as { id: number; name: string; mobile: string };
  };
  const edit = async (id: number, body: Record<string, unknown>, token = apex) =>
    request(await getApp())
      .patch(`/api/admissions/applications/${id}`)
      .set(bearer(token))
      .send(body);
  const admit = async (id: number, body: Record<string, unknown> = {}) =>
    request(await getApp())
      .post(`/api/admissions/applications/${id}/admit`)
      .set(bearer(apex))
      .send(body);
  const fetchApplication = async (id: number) =>
    (
      await request(await getApp())
        .get(`/api/admissions/applications/${id}`)
        .set(bearer(apex))
    ).body;
  const audits = (action: string, entityId: number) =>
    AuditEvent.findAll({
      where: { instituteId: 1, action, entityId: String(entityId) },
      order: [['id', 'ASC']],
    });

  it('edits an application until it is admitted, validating it like the form', async () => {
    const app = await getApp();
    const { id } = await apply({ courseId: courseA });

    const renamed = await edit(id, { name: 'Edited Kid', email: 'Edited.Kid@Example.com' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'Edited Kid',
      email: 'edited.kid@example.com',
      courseId: courseA,
      courseName: `Course A ${run}`,
      batchId: null,
    });
    expect((await audits('application.updated', id))[0].metadata).toMatchObject({
      fields: ['name', 'email'],
    });
    // Unchanged values (the edit form sends every field) are not a change.
    expect((await edit(id, { name: 'Edited Kid', courseId: courseA })).status).toBe(200);
    expect(await audits('application.updated', id)).toHaveLength(1);
    expect((await edit(id, { mobile: '12' })).status).toBe(422);

    // A batch brings its course; it must fit the course and branch, and moving either drops it.
    expect((await edit(id, { batchId: otherBatch })).body).toMatchObject({
      courseId: courseB,
      batchId: otherBatch,
    });
    expect((await edit(id, { courseId: courseA, batchId: otherBatch })).status).toBe(400);
    expect((await edit(id, { courseId: 99_999_999 })).status).toBe(404);
    expect((await edit(id, { courseId: courseA })).body).toMatchObject({ courseId: courseA, batchId: null });
    expect((await edit(id, { batchId: smallBatch })).body.batchId).toBe(smallBatch);
    expect((await edit(id, { branchId: baner })).body).toMatchObject({
      branchId: baner,
      courseId: courseA,
      batchId: null,
    });
    expect((await edit(id, { batchId: smallBatch })).status).toBe(400); // a Kothrud batch
    const placement = (await audits('application.updated', id)).at(-1)!.metadata;
    expect(placement).toMatchObject({
      before: { branchId: kothrud, courseId: courseA, batchId: smallBatch },
      after: { branchId: baner, courseId: courseA, batchId: null },
    });

    // Form data is checked against the application's admission form.
    const form = await request(app)
      .post('/api/admissions/forms')
      .set(bearer(apex))
      .send({
        name: `Admission ${run}`,
        purpose: 'admission',
        branchId: baner,
        fields: [{ key: 'school', label: 'School', type: 'text', required: true }],
      });
    expect(form.status).toBe(201);
    try {
      const missing = await edit(id, { formData: {} });
      expect(missing.status).toBe(422);
      expect(missing.body.error.details[0].path).toBe('customFields.school');
      expect((await edit(id, { formData: { school: 'KV', junk: 1 } })).body).toMatchObject({
        formId: form.body.id,
        formData: { school: 'KV' },
      });
    } finally {
      await purgeRows('admission_forms', [form.body.id]);
    }

    // Admitted applications are closed to edits.
    expect((await admit(id)).status).toBe(201);
    const closed = await edit(id, { name: 'Too Late' });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('APPLICATION_CLOSED');
  });

  it('moves an edited waitlisted application to the end of its new list', async () => {
    const first = await apply({ courseId: courseA, waitlist: true });
    const second = await apply({ courseId: courseA, waitlist: true });
    await apply({ courseId: courseB, waitlist: true });
    const moved = await edit(first.id, { courseId: courseB });
    expect(moved.body).toMatchObject({ status: 'waitlisted', courseId: courseB, waitlistPosition: 2 });
    expect((await fetchApplication(second.id)).waitlistPosition).toBe(1);
  });

  it('admits into a batch chosen when admitting, enrolling the student through academics', async () => {
    const app = await getApp();
    const { id, mobile: familyMobile } = await apply({ courseId: courseA });
    const options = await request(app).get(`/api/admissions/applications/${id}/batches`).set(bearer(apex));
    expect(options.status).toBe(200);
    const offered = options.body as { id: number; seatsLeft: number }[];
    expect(offered.map((o) => o.id)).toEqual(expect.arrayContaining([smallBatch, roomyBatch]));
    expect(offered.map((o) => o.id)).not.toContain(cancelledBatch);
    expect(offered.map((o) => o.id)).not.toContain(otherBatch);
    expect(offered.find((o) => o.id === smallBatch)!.seatsLeft).toBe(1);

    expect((await admit(id, { batchId: otherBatch })).status).toBe(400);
    const cancelled = await admit(id, { batchId: cancelledBatch });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('BATCH_CLOSED');
    expect(await fetchApplication(id)).toMatchObject({ status: 'pending', batchId: null });

    const admitted = await admit(id, { batchId: smallBatch });
    expect(admitted.status).toBe(201);
    expect(admitted.body).toMatchObject({
      batchEnrolment: 'enrolled',
      application: { status: 'admitted', courseId: courseA, batchId: smallBatch, batchName: `Small ${run}` },
    });
    const userId = admitted.body.student.userId as number;
    expect(
      await BatchStudent.count({
        where: { instituteId: 1, batchId: smallBatch, studentUserId: userId, status: 'active' },
      }),
    ).toBe(1);
    expect((await audits('batch.students_enrolled', smallBatch))[0].metadata).toMatchObject({
      studentUserIds: [userId],
      source: 'admission',
      applicationId: id,
    });
    expect((await audits('application.admitted', id))[0].metadata).toMatchObject({
      batchId: smallBatch,
      batchEnrolment: 'enrolled',
    });

    // The one seat is taken: the next admission into the batch is refused and nothing is kept.
    const late = await apply({ courseId: courseA });
    const full = await admit(late.id, { batchId: smallBatch });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('BATCH_FULL');
    expect(await fetchApplication(late.id)).toMatchObject({ status: 'pending', batchId: null });
    const search = await request(app).get('/api/students').query({ search: late.mobile }).set(bearer(apex));
    expect(search.body.total).toBe(0);

    // `batchId: null` admits without the application's batch (assigned later in academics).
    const withBatch = await apply({ batchId: roomyBatch });
    const unplaced = await admit(withBatch.id, { batchId: null });
    expect(unplaced.status).toBe(201);
    expect(unplaced.body).toMatchObject({
      batchEnrolment: null,
      application: { status: 'admitted', courseId: courseA, batchId: null },
    });
    expect(await BatchStudent.count({ where: { instituteId: 1, batchId: roomyBatch } })).toBe(0);

    // A sibling sharing the first student's mobile gets no login of their own yet, so they are
    // admitted with the batch noted but can't be enrolled in it.
    const sibling = await apply({ name: 'Edit Sibling', mobile: familyMobile, courseId: courseA });
    expect((await admit(sibling.id, { batchId: roomyBatch })).body.error.code).toBe('DUPLICATE_STUDENT');
    const shared = await admit(sibling.id, { batchId: roomyBatch, allowDuplicate: true });
    expect(shared.status).toBe(201);
    expect(shared.body).toMatchObject({
      batchEnrolment: 'no_login',
      student: { userId: null },
      application: { status: 'admitted', batchId: roomyBatch },
    });
    expect(await BatchStudent.count({ where: { instituteId: 1, batchId: roomyBatch } })).toBe(0);
  });

  it("keeps a registered student's own details on their profile and admits them into a batch", async () => {
    const app = await getApp();
    const first = await apply({ courseId: courseA });
    const student = (await admit(first.id)).body.student as { id: number; userId: number };
    const linked = await apply({ courseId: courseA });
    await AdmissionApplication.update(
      { studentId: student.id },
      { where: { instituteId: 1, id: linked.id } },
    );

    const renamed = await edit(linked.id, { name: 'Someone Else' });
    expect(renamed.status).toBe(400);
    expect(renamed.body.error.message).toContain("student's profile");
    expect((await edit(linked.id, { name: linked.name, batchId: roomyBatch })).body.batchId).toBe(roomyBatch);
    const options = await request(app)
      .get(`/api/admissions/applications/${linked.id}/batches`)
      .set(bearer(apex));
    expect(options.body.map((o: { id: number }) => o.id)).toContain(roomyBatch);

    const admitted = await admit(linked.id);
    expect(admitted.status).toBe(201);
    expect(admitted.body).toMatchObject({
      batchEnrolment: 'enrolled',
      application: { studentId: student.id, batchId: roomyBatch },
      student: { id: student.id },
    });
    expect(
      await BatchStudent.count({
        where: { instituteId: 1, batchId: roomyBatch, studentUserId: student.userId, status: 'active' },
      }),
    ).toBe(1);
  });

  it('guards editing and batch choices by permission and institute', async () => {
    const app = await getApp();
    const { id } = await apply({ courseId: courseA });
    const teacher = (await login(USERS.apexTeacher)).accessToken;
    expect((await edit(id, { name: 'Nope Kid' }, teacher)).status).toBe(403);
    expect((await edit(id, { name: 'Nope Kid' }, zenith)).status).toBe(404);
    for (const [token, status] of [
      [teacher, 403],
      [zenith, 404],
    ] as const)
      expect(
        (await request(app).get(`/api/admissions/applications/${id}/batches`).set(bearer(token))).status,
      ).toBe(status);
    // Another institute's batch can't be chosen.
    const zenithApp = await request(app)
      .post('/api/admissions/applications')
      .set(bearer(zenith))
      .send({ name: 'Zen Kid', mobile: mobile() });
    expect(zenithApp.status).toBe(201);
    expect((await edit(zenithApp.body.id, { batchId: roomyBatch }, zenith)).status).toBe(404);
    expect((await fetchApplication(id)).name).toBe('Edit Kid');
  });
});
