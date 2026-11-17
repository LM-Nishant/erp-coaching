import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import { User } from '../src/modules/users/user.model';
import { USERS, bearer, getApp, login } from './helpers';

let seq = 0;
const mobile = () => `933${String(seq++).padStart(7, '0')}`;

describe('admissions', () => {
  let apex: string;
  let zenith: string;
  let branchAdminId: number;

  beforeAll(async () => {
    await getApp();
    apex = (await login(USERS.apexAdmin)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    branchAdminId = (await User.findOne({ where: { mobile: USERS.apexBranchAdmin.mobile } }))!.id;
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
    const sms = consoleOutbox.find((msg) => msg.data?.followUpId === fu.body.id);
    expect(sms?.to).toBe(USERS.apexBranchAdmin.mobile);
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
    const courseId = 9001;
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
});
