import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Job } from '../src/infrastructure/jobs/job.model';
import { BatchStudent } from '../src/modules/academics/models';
import { AdmissionApplication, Enquiry } from '../src/modules/admissions/models';
import { Branch } from '../src/modules/branches/branch.model';
import { NotificationMessage } from '../src/modules/notifications/models';
import { Student } from '../src/modules/students/models';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { USERS, bearer, getApp, login, purgeAcademicFixtures, purgeRows } from './helpers';

const run = Date.now().toString(36).slice(-4).toUpperCase();
const PREFIX = '94403';
let seq = 0;
const mobile = () => `${PREFIX}${String(seq++).padStart(5, '0')}`;
const BYPASS = { tenantBypass: true } as object;

describe('self-registration for a course → admissions intent', () => {
  let app: Express;
  let admin: string;
  let zenith: string;
  let branchId: number;
  let sessionId: number;
  let courseId: number;
  let courseName: string;
  let batchId: number;
  let zenithCourseId: number;
  let jobWatermark = 0;
  let messageWatermark = 0;
  const created = {
    courseIds: [] as number[],
    batchIds: [] as number[],
    studentIds: [] as number[],
    userIds: [] as number[],
    referralIds: [] as number[],
  };

  async function register(body: Record<string, unknown>, query: Record<string, unknown> = {}) {
    const res = await request(app)
      .post('/api/public/institutes/apex/register')
      .query(query)
      .send({ branchId, ...body });
    if (res.status === 201) {
      const s = (await Student.findOne({ where: { instituteId: 1, id: res.body.studentId } }))!;
      created.studentIds.push(s.id);
      if (s.userId) created.userIds.push(s.userId);
    }
    return res;
  }
  const enquiriesFor = async (m: string) =>
    (await request(app).get('/api/admissions/enquiries').query({ search: m }).set(bearer(admin))).body.items;
  const applicationsFor = async (m: string) =>
    (await request(app).get('/api/admissions/applications').query({ search: m }).set(bearer(admin))).body
      .items;
  const admit = (applicationId: number) =>
    request(app).post(`/api/admissions/applications/${applicationId}/admit`).set(bearer(admin)).send({});
  const audits = (action: string, entityId: number) =>
    AuditEvent.findAll({ where: { instituteId: 1, action, entityId: String(entityId) } });

  beforeAll(async () => {
    app = await getApp();
    jobWatermark = (await Job.max<number, Job>('id')) ?? 0;
    messageWatermark = (await NotificationMessage.max<number, NotificationMessage>('id', BYPASS)) ?? 0;
    [admin, zenith] = await Promise.all(
      [USERS.apexAdmin, USERS.zenithAdmin].map(async (u) => (await login(u)).accessToken),
    );
    branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;
    const zenithBranchId = (await Branch.findOne({ where: { instituteId: 2 }, order: [['id', 'ASC']] }))!.id;

    courseName = `SR Course ${run}`;
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: courseName, code: `SRC-${run}`, branchIds: [branchId] });
    expect(course.status).toBe(201);
    courseId = course.body.id;
    created.courseIds.push(courseId);
    const foreign = await request(app)
      .post('/api/academics/courses')
      .set(bearer(zenith))
      .send({ name: `SR Foreign ${run}`, code: `SRZ-${run}`, branchIds: [zenithBranchId] });
    expect(foreign.status).toBe(201);
    zenithCourseId = foreign.body.id;
    created.courseIds.push(zenithCourseId);

    const session = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: `SR-${run}`, startDate: '2053-04-01', endDate: '2054-03-31' });
    expect(session.status).toBe(201);
    sessionId = session.body.id;
    const batch = await request(app)
      .post('/api/academics/batches')
      .set(bearer(admin))
      .send({
        branchId,
        courseId,
        academicSessionId: sessionId,
        name: 'SR Batch 1',
        code: `SRB-${run}`,
        capacity: 5,
        startDate: '2053-04-01',
      });
    expect(batch.status).toBe(201);
    batchId = batch.body.id;
    created.batchIds.push(batchId);
  });

  afterAll(async () => {
    const mine = { [Op.like]: `${PREFIX}%` };
    const applications = await AdmissionApplication.findAll({
      where: { instituteId: 1, mobile: mine },
      attributes: ['id'],
    });
    await purgeRows(
      'admission_applications',
      applications.map((a) => a.id),
    );
    const enquiries = await Enquiry.findAll({ where: { instituteId: 1, mobile: mine }, attributes: ['id'] });
    await purgeRows(
      'enquiries',
      enquiries.map((e) => e.id),
    );
    await purgeRows('students', created.studentIds);
    await purgeRows('users', created.userIds);
    await purgeRows('website_referral_codes', created.referralIds);
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
  });

  it('creates a referral enquiry and a pending application linked to the student; admitting confirms that student', async () => {
    const code = `SRC-${run}`;
    const referral = await request(app)
      .post('/api/website/referrals')
      .set(bearer(admin))
      .send({ code, name: 'Self-registration course referral' });
    expect(referral.status).toBe(201);
    created.referralIds.push(referral.body.id);

    const m = mobile();
    // `ref`/`courseId` arrive on the query string of shared links (/register/apex?ref=…&courseId=…).
    const reg = await register(
      { name: 'SR Student One', mobile: m, password: 'Secret@123' },
      { ref: code.toLowerCase(), courseId: String(courseId) },
    );
    expect(reg.status).toBe(201);
    const studentId = reg.body.studentId as number;

    const [enquiry, ...moreEnquiries] = await enquiriesFor(m);
    expect(moreEnquiries).toEqual([]);
    expect(enquiry).toMatchObject({
      name: 'SR Student One',
      source: 'referral',
      status: 'new',
      courseId,
      courseInterest: courseName,
      studentId,
      branchId,
    });
    expect(enquiry.notes).toContain(`Self-registered online for ${courseName}`);
    expect(enquiry.notes).toContain(`referral code ${code}.`);
    const [application, ...moreApplications] = await applicationsFor(m);
    expect(moreApplications).toEqual([]);
    expect(application).toMatchObject({
      status: 'pending',
      courseId,
      courseName,
      batchId: null,
      batchName: null,
      studentId,
      enquiryId: enquiry.id,
      branchId,
    });
    const [attribution] = await audits('student.self_registration_attribution', studentId);
    expect(attribution.metadata).toMatchObject({
      referralCode: code,
      referralCounted: true,
      courseId,
      enquiryId: enquiry.id,
      applicationId: application.id,
    });
    expect(await audits('application.created', application.id)).toHaveLength(1);
    expect(await audits('enquiry.created', enquiry.id)).toHaveLength(1);

    // Another institute can't see them.
    expect(
      (await request(app).get(`/api/admissions/enquiries/${enquiry.id}`).set(bearer(zenith))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/admissions/applications/${application.id}`).set(bearer(zenith))).status,
    ).toBe(404);

    // The student record exists already: the enquiry can't create another one.
    const convert = await request(app)
      .post(`/api/admissions/enquiries/${enquiry.id}/convert`)
      .set(bearer(admin))
      .send({});
    expect(convert.status).toBe(409);
    expect(convert.body.error.code).toBe('ALREADY_CONVERTED');

    const admitted = await admit(application.id);
    expect(admitted.status).toBe(201);
    expect(admitted.body.student).toMatchObject({ id: studentId, admissionNumber: reg.body.admissionNumber });
    expect(admitted.body.application).toMatchObject({ status: 'admitted', studentId });
    expect(await Student.count({ where: { instituteId: 1, mobile: m } })).toBe(1);
    const [admitAudit] = await audits('application.admitted', application.id);
    expect(admitAudit.metadata).toMatchObject({ studentId, existingStudent: true });
    const after = await request(app).get(`/api/admissions/enquiries/${enquiry.id}`).set(bearer(admin));
    expect(after.body).toMatchObject({ status: 'converted', studentId });

    const again = await admit(application.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('APPLICATION_CLOSED');
  });

  it("links the person's earlier enquiry and application instead of duplicating them; admitting enrols in its batch", async () => {
    const m = mobile();
    const name = 'SR Student Two';
    const enquiry = await request(app)
      .post('/api/admissions/enquiries')
      .set(bearer(admin))
      .send({ name, mobile: m, source: 'phone', branchId });
    expect(enquiry.status).toBe(201);
    const application = await request(app)
      .post('/api/admissions/applications')
      .set(bearer(admin))
      .send({ name, mobile: m, branchId, enquiryId: enquiry.body.id, courseId, batchId });
    expect(application.status).toBe(201);

    const reg = await register({ name, mobile: m, courseId });
    expect(reg.status).toBe(201);
    const studentId = reg.body.studentId as number;

    const enquiries = await enquiriesFor(m);
    expect(enquiries).toEqual([
      expect.objectContaining({ id: enquiry.body.id, source: 'phone', status: 'new', courseId, studentId }),
    ]);
    expect(enquiries[0].notes).toContain(`Self-registered online for ${courseName}`);
    expect(await applicationsFor(m)).toEqual([
      expect.objectContaining({
        id: application.body.id,
        status: 'pending',
        studentId,
        enquiryId: enquiry.body.id,
        batchId,
        batchName: 'SR Batch 1',
      }),
    ]);
    const [linked] = await audits('application.linked', application.body.id);
    expect(linked.metadata).toMatchObject({ source: 'self_registration', studentId, courseId });

    const admitted = await admit(application.body.id);
    expect(admitted.status).toBe(201);
    expect(admitted.body.student.id).toBe(studentId);
    const { userId } = (await Student.findOne({ where: { instituteId: 1, id: studentId } }))!;
    expect(
      await BatchStudent.count({
        where: { instituteId: 1, batchId, studentUserId: userId!, status: 'active' },
      }),
    ).toBe(1);
    const after = await request(app).get(`/api/admissions/enquiries/${enquiry.body.id}`).set(bearer(admin));
    expect(after.body).toMatchObject({ status: 'converted', studentId });
  });

  it('links an open enquiry and adds the application, notes unknown referral codes and ignores foreign courses', async () => {
    const m = mobile();
    const name = 'SR Student Three';
    const walkIn = await request(app)
      .post('/api/admissions/enquiries')
      .set(bearer(admin))
      .send({ name, mobile: m, source: 'walk_in', branchId });
    expect(walkIn.status).toBe(201);
    // A closed enquiry of the same person is left alone.
    const lost = await request(app)
      .post('/api/admissions/enquiries')
      .set(bearer(admin))
      .send({ name, mobile: m, source: 'phone', branchId });
    expect(
      (
        await request(app)
          .patch(`/api/admissions/enquiries/${lost.body.id}`)
          .set(bearer(admin))
          .send({ status: 'lost' })
      ).status,
    ).toBe(200);

    const reg = await register({ name, mobile: m, courseId, ref: 'NO-SUCH-REF' });
    expect(reg.status).toBe(201);
    const studentId = reg.body.studentId as number;
    const enquiries = await enquiriesFor(m);
    expect(enquiries).toHaveLength(2);
    const linked = enquiries.find((e: { id: number }) => e.id === walkIn.body.id);
    expect(linked).toMatchObject({ source: 'walk_in', courseId, courseInterest: courseName, studentId });
    expect(linked.notes).toContain('referral code NO-SUCH-REF (not recognised).');
    expect(enquiries.find((e: { id: number }) => e.id === lost.body.id)).toMatchObject({
      status: 'lost',
      studentId: null,
      courseId: null,
    });
    expect(await applicationsFor(m)).toEqual([
      expect.objectContaining({ status: 'pending', courseId, studentId, enquiryId: walkIn.body.id }),
    ]);

    // Another institute's course, or no course at all: registered, nothing for admissions.
    for (const [i, otherCourse] of [zenithCourseId, 99_999_999].entries()) {
      const other = mobile();
      const res = await register({ name: `SR Foreign ${i}`, mobile: other, courseId: otherCourse });
      expect(res.status).toBe(201);
      expect(await enquiriesFor(other)).toEqual([]);
      expect(await applicationsFor(other)).toEqual([]);
      const [attribution] = await audits('student.self_registration_attribution', res.body.studentId);
      expect(attribution.metadata).toMatchObject({
        courseId: otherCourse,
        enquiryId: null,
        applicationId: null,
      });
    }
  });
});
