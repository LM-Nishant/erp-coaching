import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Op } from 'sequelize';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';
import { User } from '../src/modules/users/user.model';
import { GrievanceTicket } from '../src/modules/grievances/grievances.models';
import { setLinkedStudentsResolver } from '../src/modules/grievances/grievances.links';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { Job } from '../src/infrastructure/jobs/job.model';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';
import { csvCell } from '../src/modules/grievances/grievances.service';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
const PARENT = { mobile: '9100000006', password: DEMO_PASSWORD };
const ZENITH_STUDENT = { mobile: '9200000005', password: DEMO_PASSWORD };

describe('grievances module', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let branchAdmin: string;
  let teacher: string;
  let student: string;
  let parent: string;
  let zenith: string;
  let zenithStudent: string;
  let ids: Record<'branchAdmin' | 'student' | 'teacher', number>;
  let categoryId: number;
  let ticketId: number;

  const year = new Date().getUTCFullYear();

  beforeAll(async () => {
    app = await getApp();
    [admin, branchAdmin, teacher, student, parent, zenith, zenithStudent] = await Promise.all(
      [
        USERS.apexAdmin,
        USERS.apexBranchAdmin,
        USERS.apexTeacher,
        STUDENT,
        PARENT,
        USERS.zenithAdmin,
        ZENITH_STUDENT,
      ].map(async (u) => (await login(u)).accessToken),
    );
    const users = await User.findAll({
      where: { mobile: { [Op.in]: ['9100000002', '9100000005', '9100000004'] } },
    });
    const byMobile = (m: string) => users.find((u) => u.mobile === m)!.id;
    ids = {
      branchAdmin: byMobile('9100000002'),
      student: byMobile('9100000005'),
      teacher: byMobile('9100000004'),
    };
  });

  afterAll(() => setLinkedStudentsResolver(async () => []));

  it('seeds default categories and lets admins manage categories and settings', async () => {
    const list = await request(app).get('/api/grievances/categories').set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(5);

    const created = await request(app)
      .post('/api/grievances/categories')
      .set(bearer(admin))
      .send({ name: 'Hostel', slaHours: 24, defaultAssigneeUserId: ids.branchAdmin });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Hostel', slaHours: 24 });
    categoryId = created.body.id;

    const dup = await request(app)
      .post('/api/grievances/categories')
      .set(bearer(admin))
      .send({ name: 'hostel' });
    expect(dup.status).toBe(409);

    const patched = await request(app)
      .patch(`/api/grievances/categories/${categoryId}`)
      .set(bearer(admin))
      .send({ description: 'Rooms & mess' });
    expect(patched.body.description).toBe('Rooms & mess');

    const settings = await request(app).get('/api/grievances/settings').set(bearer(admin));
    expect(settings.body.ticketPrefix).toBe('GRV');

    const temp = await request(app)
      .post('/api/grievances/categories')
      .set(bearer(admin))
      .send({ name: 'Temp' });
    expect(
      (await request(app).delete(`/api/grievances/categories/${temp.body.id}`).set(bearer(admin))).status,
    ).toBe(204);
  });

  it('forbids students and teachers from configuring', async () => {
    expect(
      (await request(app).post('/api/grievances/categories').set(bearer(student)).send({ name: 'X' })).status,
    ).toBe(403);
    expect((await request(app).get('/api/grievances/settings').set(bearer(teacher))).status).toBe(403);
    expect((await request(app).get('/api/grievances/reports/summary').set(bearer(student))).status).toBe(403);
    expect((await request(app).get('/api/grievances/reports/export.csv').set(bearer(teacher))).status).toBe(
      403,
    );
  });

  it('lets a student file a complaint with an institute ticket number, SLA and default assignee', async () => {
    const res = await request(app)
      .post('/api/grievances')
      .set(bearer(student))
      .send({
        categoryId,
        subject: 'Mess food quality',
        description: 'Food is cold every day',
        priority: 'high',
        instituteId: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.ticketNumber).toMatch(new RegExp(`^GRV-${year}-\\d{5}$`));
    expect(res.body).toMatchObject({ status: 'open', priority: 'high', requesterType: 'student' });
    expect(res.body.assignee.id).toBe(ids.branchAdmin);
    const hours = (new Date(res.body.dueAt).getTime() - new Date(res.body.createdAt).getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(24);
    ticketId = res.body.id;

    const row = await GrievanceTicket.findOne({ where: { id: ticketId, instituteId: 1 } });
    expect(row).not.toBeNull();
    expect(await Job.count({ where: { name: 'grievances.sla-check', status: 'pending' } })).toBeGreaterThan(
      0,
    );
  });

  it('allocates unique ticket numbers under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .post('/api/grievances')
          .set(bearer(i % 2 ? teacher : student))
          .send({ categoryId, subject: `Concurrent ${i}`, description: 'race' }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.ticketNumber);
    expect(new Set(numbers).size).toBe(10);

    // Zenith keeps its own sequence.
    const zcats = await request(app).get('/api/grievances/categories').set(bearer(zenith));
    const z = await request(app)
      .post('/api/grievances')
      .set(bearer(zenithStudent))
      .send({ categoryId: zcats.body[0].id, subject: 'Zenith issue', description: 'x' });
    expect(z.status).toBe(201);
    expect(z.body.ticketNumber).toBe(`GRV-${year}-00001`);
  });

  it('shows requesters only their own tickets', async () => {
    const mine = await request(app).get('/api/grievances').set(bearer(student));
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((t: { requester: { id: number } }) => t.requester.id === ids.student)).toBe(
      true,
    );

    const teacherTicket = await GrievanceTicket.findOne({
      where: { instituteId: 1, requesterUserId: ids.teacher },
    });
    expect((await request(app).get(`/api/grievances/${teacherTicket!.id}`).set(bearer(student))).status).toBe(
      404,
    );

    const queue = await request(app).get('/api/grievances?pageSize=100').set(bearer(branchAdmin));
    expect(queue.body.total).toBeGreaterThanOrEqual(11);

    expect(
      (
        await request(app)
          .post(`/api/grievances/${ticketId}/assign`)
          .set(bearer(student))
          .send({ assigneeUserId: null })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/grievances/${ticketId}/status`)
          .set(bearer(student))
          .send({ status: 'resolved' })
      ).status,
    ).toBe(403);
  });

  it('hides internal notes and internal attachments from the requester', async () => {
    const note = await request(app)
      .post(`/api/grievances/${ticketId}/comments`)
      .set(bearer(branchAdmin))
      .send({ body: 'Check with mess vendor', internal: true });
    expect(note.status).toBe(201);
    const reply = await request(app)
      .post(`/api/grievances/${ticketId}/comments`)
      .set(bearer(branchAdmin))
      .send({ body: 'We are looking into it' });
    expect(reply.status).toBe(201);

    expect(
      (
        await request(app)
          .post(`/api/grievances/${ticketId}/comments`)
          .set(bearer(student))
          .send({ body: 'sneaky', internal: true })
      ).status,
    ).toBe(403);

    const pub = await request(app)
      .post(`/api/grievances/${ticketId}/attachments`)
      .set(bearer(student))
      .attach('file', Buffer.from('photo'), { filename: 'food.txt', contentType: 'text/plain' });
    expect(pub.status).toBe(201);
    const internal = await request(app)
      .post(`/api/grievances/${ticketId}/attachments`)
      .set(bearer(branchAdmin))
      .field('internal', 'true')
      .attach('file', Buffer.from('invoice'), { filename: 'vendor.txt', contentType: 'text/plain' });
    expect(internal.status).toBe(201);

    const url = await request(app)
      .get(`/api/grievances/${ticketId}/attachments/${pub.body.id}/url`)
      .set(bearer(student));
    expect(url.status).toBe(200);
    const dl = await request(app).get(new URL(url.body.url).pathname);
    expect(dl.text).toBe('photo');
    expect(
      (
        await request(app)
          .get(`/api/grievances/${ticketId}/attachments/${internal.body.id}/url`)
          .set(bearer(student))
      ).status,
    ).toBe(404);

    const asStudent = await request(app).get(`/api/grievances/${ticketId}`).set(bearer(student));
    expect(asStudent.body.canManage).toBe(false);
    expect(asStudent.body.activities.some((a: { isInternal: boolean }) => a.isInternal)).toBe(false);
    expect(asStudent.body.attachments).toHaveLength(1);
    expect(asStudent.body.firstResponseAt).not.toBeNull();

    const asStaff = await request(app).get(`/api/grievances/${ticketId}`).set(bearer(branchAdmin));
    expect(asStaff.body.canManage).toBe(true);
    expect(asStaff.body.activities.some((a: { isInternal: boolean }) => a.isInternal)).toBe(true);
    expect(asStaff.body.attachments).toHaveLength(2);
  });

  it('enforces the status lifecycle, resolution notes, closure confirmation and reopen', async () => {
    const assign = await request(app)
      .post(`/api/grievances/${ticketId}/assign`)
      .set(bearer(admin))
      .send({ assigneeUserId: ids.branchAdmin, note: 'Please own this' });
    expect(assign.status).toBe(200);

    const bad = await request(app)
      .post(`/api/grievances/${ticketId}/status`)
      .set(bearer(branchAdmin))
      .send({ status: 'closed' });
    expect(bad.status).toBe(200); // open → closed is allowed by staff (e.g. duplicates)
    const reopenStaff = await request(app)
      .post(`/api/grievances/${ticketId}/status`)
      .set(bearer(branchAdmin))
      .send({ status: 'open' });
    expect(reopenStaff.body).toMatchObject({ status: 'open', reopenCount: 1 });

    expect(
      (
        await request(app)
          .post(`/api/grievances/${ticketId}/status`)
          .set(bearer(branchAdmin))
          .send({ status: 'open' })
      ).status,
    ).toBe(409);

    const progress = await request(app)
      .post(`/api/grievances/${ticketId}/status`)
      .set(bearer(branchAdmin))
      .send({ status: 'in_progress' });
    expect(progress.body.status).toBe('in_progress');

    const noNotes = await request(app)
      .post(`/api/grievances/${ticketId}/status`)
      .set(bearer(branchAdmin))
      .send({ status: 'resolved' });
    expect(noNotes.status).toBe(400);

    const resolved = await request(app)
      .post(`/api/grievances/${ticketId}/status`)
      .set(bearer(branchAdmin))
      .send({ status: 'resolved', resolutionNotes: 'Vendor replaced' });
    expect(resolved.body).toMatchObject({ status: 'resolved', resolutionNotes: 'Vendor replaced' });

    expect(
      (
        await request(app)
          .post(`/api/grievances/${ticketId}/confirm-closure`)
          .set(bearer(branchAdmin))
          .send({})
      ).status,
    ).toBe(403);

    const closed = await request(app)
      .post(`/api/grievances/${ticketId}/confirm-closure`)
      .set(bearer(student))
      .send({ rating: 4, feedback: 'Better now' });
    expect(closed.body).toMatchObject({ status: 'closed', closureConfirmed: true, satisfactionRating: 4 });

    expect(
      (
        await request(app)
          .post(`/api/grievances/${ticketId}/comments`)
          .set(bearer(student))
          .send({ body: 'hi' })
      ).status,
    ).toBe(409);

    const reopened = await request(app)
      .post(`/api/grievances/${ticketId}/reopen`)
      .set(bearer(student))
      .send({ reason: 'Problem is back' });
    expect(reopened.body).toMatchObject({ status: 'open', reopenCount: 2, closureConfirmed: null });
  });

  it('auto-escalates tickets past their SLA via the scheduled job', async () => {
    const created = await request(app)
      .post('/api/grievances')
      .set(bearer(student))
      .send({ categoryId, subject: 'Overdue', description: 'nobody answered' });
    await GrievanceTicket.update(
      { dueAt: new Date(Date.now() - 60_000) },
      { where: { id: created.body.id, instituteId: 1 } },
    );
    await Job.update(
      { runAt: new Date(Date.now() - 1000) },
      { where: { name: 'grievances.sla-check', status: 'pending' } },
    );
    await processDueJobs(200);

    const after = await request(app).get(`/api/grievances/${created.body.id}`).set(bearer(branchAdmin));
    expect(after.body).toMatchObject({ status: 'escalated', slaBreached: true, escalationLevel: 1 });
    expect(after.body.activities.some((a: { type: string }) => a.type === 'escalation')).toBe(true);

    const overdue = await request(app).get('/api/grievances?status=escalated').set(bearer(branchAdmin));
    expect(overdue.body.items.some((t: { id: number }) => t.id === created.body.id)).toBe(true);
  });

  it('delivers notifications through the messaging adapter', async () => {
    const before = consoleOutbox.length;
    await request(app)
      .post(`/api/grievances/${ticketId}/comments`)
      .set(bearer(branchAdmin))
      .send({ body: 'Update: vendor visit tomorrow' });
    await processDueJobs(200);
    const sent = consoleOutbox.slice(before);
    expect(sent.some((m) => m.to === STUDENT.mobile && m.data?.kind === 'grievance')).toBe(true);
  });

  it('lets parents file only for linked children', async () => {
    const denied = await request(app)
      .post('/api/grievances')
      .set(bearer(parent))
      .send({ categoryId, subject: 'For my child', description: 'x', onBehalfOfUserId: ids.student });
    expect(denied.status).toBe(403);

    setLinkedStudentsResolver(async () => [{ id: ids.student, name: 'Apex Student' }]);
    const linked = await request(app).get('/api/grievances/linked-students').set(bearer(parent));
    expect(linked.body).toEqual([{ id: ids.student, name: 'Apex Student' }]);
    const ok = await request(app)
      .post('/api/grievances')
      .set(bearer(parent))
      .send({ categoryId, subject: 'For my child', description: 'x', onBehalfOfUserId: ids.student });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ requesterType: 'parent', onBehalfOf: { id: ids.student } });

    // The child does not see the parent's ticket (requesters only see their own).
    expect((await request(app).get(`/api/grievances/${ok.body.id}`).set(bearer(student))).status).toBe(404);
  });

  it('reports response/resolution times and exports CSV', async () => {
    const summary = await request(app).get('/api/grievances/reports/summary').set(bearer(admin));
    expect(summary.status).toBe(200);
    expect(summary.body.total).toBeGreaterThanOrEqual(12);
    expect(summary.body.slaBreached).toBeGreaterThanOrEqual(1);
    expect(summary.body.byStatus.escalated).toBeGreaterThanOrEqual(1);

    const csv = await request(app).get('/api/grievances/reports/export.csv').set(bearer(admin));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toContain('Ticket');
    expect(lines.length).toBeGreaterThanOrEqual(13);
    expect(lines.length).toBe(summary.body.total + 1);

    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('isolates tickets between institutes (Apex → Zenith)', async () => {
    const z = await GrievanceTicket.findOne({ where: { instituteId: 2 } });
    expect(z).not.toBeNull();
    expect((await request(app).get(`/api/grievances/${z!.id}`).set(bearer(admin))).status).toBe(404);
    expect(
      (await request(app).patch(`/api/grievances/${z!.id}`).set(bearer(admin)).send({ priority: 'low' }))
        .status,
    ).toBe(404);
    expect(
      (await request(app).post(`/api/grievances/${z!.id}/comments`).set(bearer(admin)).send({ body: 'hi' }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/grievances/${z!.id}/status`)
          .set(bearer(admin))
          .send({ status: 'closed' })
      ).status,
    ).toBe(404);
    const zcats = await request(app).get('/api/grievances/categories').set(bearer(zenith));
    expect(
      (
        await request(app)
          .post('/api/grievances')
          .set(bearer(student))
          .send({ categoryId: zcats.body[0].id, subject: 'x', description: 'y' })
      ).status,
    ).toBe(404);
    const queue = await request(app).get('/api/grievances?pageSize=100').set(bearer(admin));
    expect(queue.body.items.some((t: { id: number }) => t.id === z!.id)).toBe(false);
  });
});
