import request from 'supertest';
import { Op } from 'sequelize';
import { beforeAll, describe, expect, it } from 'vitest';
import { consoleOutbox } from '../src/infrastructure/messaging';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { Job } from '../src/infrastructure/jobs/job.model';
import { runWithContext } from '../src/shared/context';
import { User } from '../src/modules/users/user.model';
import { notify } from '../src/modules/notifications/api';
import { NotificationMessage, NotificationProvider } from '../src/modules/notifications/models';
import { DELIVER_JOB } from '../src/modules/notifications/notify.service';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

const APEX_STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
const asApex = <T>(fn: () => Promise<T>) =>
  runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, fn);

const findMessage = (id: number) => NotificationMessage.findOne({ where: { id, instituteId: 1 } });

/** Makes every pending delivery job due now (skips the backoff wait). */
async function fastForwardDeliveries() {
  await Job.update(
    { runAt: new Date(Date.now() - 1000) },
    { where: { name: DELIVER_JOB, status: 'pending' } },
  );
}

describe('notifications module', () => {
  let admin: string;
  let teacher: string;
  let student: string;
  let zenith: string;
  let studentId: number;
  let teacherId: number;

  beforeAll(async () => {
    await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    teacher = (await login(USERS.apexTeacher)).accessToken;
    student = (await login(APEX_STUDENT)).accessToken;
    zenith = (await login(USERS.zenithAdmin)).accessToken;
    studentId = (await User.findOne({ where: { mobile: APEX_STUDENT.mobile } }))!.id;
    teacherId = (await User.findOne({ where: { mobile: USERS.apexTeacher.mobile } }))!.id;
  });

  it('lists the seeded event catalogue', async () => {
    const res = await request(await getApp())
      .get('/api/notifications/events')
      .set(bearer(admin));
    expect(res.status).toBe(200);
    const keys = res.body.map((e: { key: string }) => e.key);
    for (const k of [
      'registration.welcome',
      'fees.due',
      'fees.receipt',
      'attendance.absent',
      'grievances.updated',
    ])
      expect(keys).toContain(k);
  });

  it('manages templates (CRUD + preview) and isolates them per institute', async () => {
    const app = await getApp();
    const created = await request(app).post('/api/notifications/templates').set(bearer(admin)).send({
      eventKey: 'fees.receipt',
      channel: 'sms',
      body: 'Paid {{amount}} for {{student.name}}',
      instituteId: 2,
    });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const dup = await request(app)
      .post('/api/notifications/templates')
      .set(bearer(admin))
      .send({ eventKey: 'fees.receipt', channel: 'sms', body: 'Again' });
    expect(dup.status).toBe(409);

    const bad = await request(app)
      .post('/api/notifications/templates')
      .set(bearer(admin))
      .send({ eventKey: 'no.such.event', channel: 'sms', body: 'x' });
    expect(bad.status).toBe(422);

    const patched = await request(app)
      .patch(`/api/notifications/templates/${id}`)
      .set(bearer(admin))
      .send({ body: 'Received Rs {{amount}} for {{student.name}}. Receipt {{receiptNo}}' });
    expect(patched.status).toBe(200);
    expect(patched.body.body).toContain('Receipt {{receiptNo}}');

    const preview = await request(app)
      .post('/api/notifications/templates/preview')
      .set(bearer(admin))
      .send({ eventKey: 'fees.receipt', body: 'Hi {{student.name}}: {{amount}}' });
    expect(preview.status).toBe(200);
    expect(preview.body.body).not.toContain('{{');

    const list = await request(app).get('/api/notifications/templates').set(bearer(admin));
    expect(list.body.map((t: { id: number }) => t.id)).toContain(id);

    // Client-supplied instituteId is ignored; Zenith cannot see or touch Apex's template.
    const zList = await request(app).get('/api/notifications/templates').set(bearer(zenith));
    expect(zList.body.map((t: { id: number }) => t.id)).not.toContain(id);
    expect(
      (
        await request(app)
          .patch(`/api/notifications/templates/${id}`)
          .set(bearer(zenith))
          .send({ body: 'Hacked' })
      ).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/notifications/templates/${id}`).set(bearer(zenith))).status).toBe(
      404,
    );
  });

  it('forbids non-admins from the admin endpoints but allows their own inbox', async () => {
    const app = await getApp();
    for (const path of ['/templates', '/providers', '/messages', '/campaigns', '/rules'])
      expect((await request(app).get(`/api/notifications${path}`).set(bearer(teacher))).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/notifications/campaigns')
          .set(bearer(teacher))
          .send({ title: 'Hi', channels: ['in_app'], body: 'x', audience: { roles: ['student'] } })
      ).status,
    ).toBe(403);
    expect((await request(app).get('/api/notifications/inbox').set(bearer(teacher))).status).toBe(200);
  });

  it('notify() renders templates, fans out to channels and fills the inbox', async () => {
    const result = await asApex(() =>
      notify({
        event: 'fees.receipt',
        recipients: [{ userIds: [studentId], type: 'student' }],
        data: { amount: 1500, student: { name: 'Riya' }, receiptNo: 'R-1', paidOn: '2026-01-01' },
      }),
    );
    // in_app (delivered), push (skipped: no device), sms (queued), email (skipped: no email)
    expect(result.messageIds).toHaveLength(4);
    expect(result.queued).toBe(1);
    expect(result.skipped).toBe(2);

    await processDueJobs();
    const sms = consoleOutbox.find((m) => m.to === APEX_STUDENT.mobile && m.body.includes('Receipt R-1'));
    expect(sms?.body).toBe('Received Rs 1500 for Riya. Receipt R-1');

    const app = await getApp();
    const count = await request(app).get('/api/notifications/inbox/unread-count').set(bearer(student));
    expect(count.body.unread).toBeGreaterThanOrEqual(1);
    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(student));
    expect(inbox.status).toBe(200);
    const item = inbox.body.items.find((i: { eventKey: string }) => i.eventKey === 'fees.receipt');
    expect(item.title).toBe('Payment received');
    expect(item.body).toContain('₹1500');

    const read = await request(app).post(`/api/notifications/inbox/${item.id}/read`).set(bearer(student));
    expect(read.body.readAt).not.toBeNull();
    // Someone else's inbox item is not reachable.
    expect(
      (await request(app).post(`/api/notifications/inbox/${item.id}/read`).set(bearer(teacher))).status,
    ).toBe(404);
    await request(app).post('/api/notifications/inbox/read-all').set(bearer(student));
    expect(
      (await request(app).get('/api/notifications/inbox/unread-count').set(bearer(student))).body.unread,
    ).toBe(0);

    // Delivery history: Apex sees it, Zenith gets 404.
    const smsMsg = await NotificationMessage.findOne({
      where: { instituteId: 1, userId: studentId, channel: 'sms', eventKey: 'fees.receipt' },
    });
    expect(smsMsg!.status).toBe('sent');
    const detail = await request(app).get(`/api/notifications/messages/${smsMsg!.id}`).set(bearer(admin));
    expect(detail.status).toBe(200);
    expect(detail.body.deliveryAttempts).toHaveLength(1);
    expect(
      (await request(app).get(`/api/notifications/messages/${smsMsg!.id}`).set(bearer(zenith))).status,
    ).toBe(404);
  });

  it('respects opt-outs and trigger rules', async () => {
    const app = await getApp();
    const prefs = await request(app)
      .put('/api/notifications/preferences')
      .set(bearer(student))
      .send({ preferences: [{ channel: 'sms', eventKey: 'fees.due', enabled: false }] });
    expect(prefs.status).toBe(200);
    expect(prefs.body).toEqual([{ channel: 'sms', eventKey: 'fees.due', enabled: false }]);

    const r1 = await asApex(() =>
      notify({
        event: 'fees.due',
        recipients: [{ userIds: [studentId], type: 'student' }],
        channels: ['sms'],
      }),
    );
    const skipped = await findMessage(r1.messageIds[0]);
    expect(skipped!.status).toBe('skipped');
    expect(skipped!.lastError).toBe('Recipient opted out');

    // Rule: fees.due only to guardians, in-app only → student-typed recipients are filtered out.
    const rule = await request(app)
      .put('/api/notifications/rules/fees.due')
      .set(bearer(admin))
      .send({ channels: ['in_app'], recipientTypes: ['guardian'] });
    expect(rule.status).toBe(200);
    const r2 = await asApex(() =>
      notify({ event: 'fees.due', recipients: [{ userIds: [studentId], type: 'student' }] }),
    );
    expect(r2.messageIds).toHaveLength(0);
    // Unknown resolvers (module not installed) are skipped, not fatal.
    const r3 = await asApex(() =>
      notify({ event: 'fees.due', recipients: [{ resolver: 'nope', args: 1, type: 'guardian' }] }),
    );
    expect(r3.messageIds).toHaveLength(0);
    expect((await request(app).delete('/api/notifications/rules/fees.due').set(bearer(admin))).status).toBe(
      200,
    );
  });

  it('retries failed deliveries with backoff and then marks them failed', async () => {
    const app = await getApp();
    const saved = await request(app)
      .put('/api/notifications/providers/sms')
      .set(bearer(admin))
      .send({
        provider: 'console',
        settings: { failPattern: USERS.apexTeacher.mobile },
        retryMaxAttempts: 2,
        retryBaseDelaySeconds: 30,
      });
    expect(saved.status).toBe(200);

    const { messageIds } = await asApex(() =>
      notify({
        event: 'classes.rescheduled',
        recipients: [teacherId],
        channels: ['sms'],
        data: { batch: 'A' },
      }),
    );
    const id = messageIds[0]!;
    await processDueJobs();
    let msg = await findMessage(id);
    expect(msg!.status).toBe('queued');
    expect(msg!.attempts).toBe(1);
    const delay = msg!.nextAttemptAt!.getTime() - Date.now();
    expect(delay).toBeGreaterThan(20_000);
    expect(delay).toBeLessThanOrEqual(30_000);

    await processDueJobs(); // not due yet
    expect((await findMessage(id))!.attempts).toBe(1);

    await fastForwardDeliveries();
    await processDueJobs();
    msg = await findMessage(id);
    expect(msg!.status).toBe('failed');
    expect(msg!.attempts).toBe(2);

    const detail = await request(app).get(`/api/notifications/messages/${id}`).set(bearer(admin));
    expect(detail.body.deliveryAttempts.map((a: { status: string }) => a.status)).toEqual([
      'failed',
      'failed',
    ]);
    const failed = await request(app).get('/api/notifications/messages?status=failed').set(bearer(admin));
    expect(failed.body.items.map((m: { id: number }) => m.id)).toContain(id);

    // Fix the provider, then retry manually.
    await request(app).delete('/api/notifications/providers/sms').set(bearer(admin));
    expect(
      (await request(app).post(`/api/notifications/messages/${id}/retry`).set(bearer(admin))).status,
    ).toBe(200);
    await processDueJobs();
    msg = await findMessage(id);
    expect(msg!.status).toBe('sent');
    expect(msg!.attempts).toBe(3);
  });

  it('stores provider credentials encrypted and never returns them', async () => {
    const app = await getApp();
    const secret = 'super-secret-auth-key-123';
    const missing = await request(app)
      .put('/api/notifications/providers/sms')
      .set(bearer(admin))
      .send({ provider: 'msg91', settings: { senderId: 'APEXED' } });
    expect(missing.status).toBe(400);

    const res = await request(app)
      .put('/api/notifications/providers/sms')
      .set(bearer(admin))
      .send({ provider: 'msg91', settings: { authKey: secret, senderId: 'APEXED' } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(res.body.settings).toEqual({ senderId: 'APEXED' });
    expect(res.body.secretHints.authKey).toBeTruthy();

    const row = await NotificationProvider.findOne({ where: { instituteId: 1, channel: 'sms' } });
    expect(row!.secretsEncrypted).not.toContain(secret);

    // Blank secret keeps the stored one.
    const again = await request(app)
      .put('/api/notifications/providers/sms')
      .set(bearer(admin))
      .send({ provider: 'msg91', settings: { authKey: '', senderId: 'APEXED2' } });
    expect(again.body.secretHints.authKey).toBe(res.body.secretHints.authKey);

    const wrongChannel = await request(app)
      .put('/api/notifications/providers/sms')
      .set(bearer(admin))
      .send({ provider: 'smtp', settings: { host: 'x', port: '25', from: 'a@b.c' } });
    expect(wrongChannel.status).toBe(400);

    const test = await request(app)
      .post('/api/notifications/providers/sms/test')
      .set(bearer(admin))
      .send({ to: '9999999999' });
    expect(test.body.ok).toBe(false);

    const zenithView = await request(app).get('/api/notifications/providers').set(bearer(zenith));
    expect(zenithView.body.find((p: { channel: string }) => p.channel === 'sms').provider).toBe('console');
    await request(app).delete('/api/notifications/providers/sms').set(bearer(admin));
  });

  it('registers push tokens and delivers push to each device', async () => {
    const app = await getApp();
    const token = `mock-web-token-${Date.now()}`;
    const reg = await request(app)
      .post('/api/notifications/push-tokens')
      .set(bearer(student))
      .send({ token, platform: 'web', deviceUid: 'dev-1' });
    expect(reg.status).toBe(201);
    expect(
      (
        await request(app)
          .post('/api/notifications/push-tokens')
          .set(bearer(student))
          .send({ token, platform: 'web' })
      ).status,
    ).toBe(200);

    const { queued } = await asApex(() =>
      notify({
        event: 'homework.assigned',
        recipients: [studentId],
        channels: ['push'],
        data: { subject: 'Maths' },
      }),
    );
    expect(queued).toBe(1);
    await processDueJobs();
    expect(consoleOutbox.some((m) => m.channel === 'push' && m.to === token)).toBe(true);

    expect(
      (await request(app).delete('/api/notifications/push-tokens').set(bearer(student)).send({ token }))
        .status,
    ).toBe(204);
  });

  it('sends bulk messages now or on schedule, and cancels scheduled ones', async () => {
    const app = await getApp();
    const now = await request(app)
      .post('/api/notifications/campaigns')
      .set(bearer(admin))
      .send({
        title: 'Holiday',
        channels: ['in_app'],
        body: 'Closed on Monday',
        audience: { roles: ['teacher'] },
      });
    expect(now.status).toBe(201);
    await processDueJobs();
    const done = await request(app).get(`/api/notifications/campaigns/${now.body.id}`).set(bearer(admin));
    expect(done.body.status).toBe('sent');
    expect(done.body.recipientCount).toBeGreaterThanOrEqual(1);
    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(teacher));
    expect(inbox.body.items.some((i: { body: string }) => i.body === 'Closed on Monday')).toBe(true);

    const later = await request(app)
      .post('/api/notifications/campaigns')
      .set(bearer(admin))
      .send({
        title: 'Later',
        channels: ['in_app'],
        body: 'Tomorrow',
        audience: { roles: ['student'] },
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      });
    expect(later.status).toBe(201);
    await processDueJobs();
    expect(
      (await request(app).get(`/api/notifications/campaigns/${later.body.id}`).set(bearer(admin))).body
        .status,
    ).toBe('scheduled');
    const cancelled = await request(app)
      .post(`/api/notifications/campaigns/${later.body.id}/cancel`)
      .set(bearer(admin));
    expect(cancelled.body.status).toBe('cancelled');

    // Batch audiences resolve through the academics module's `batchMembers` resolver.
    const batch = await request(app)
      .post('/api/notifications/campaigns')
      .set(bearer(admin))
      .send({ title: 'Batch', channels: ['in_app'], body: 'x', audience: { batchIds: [999999] } });
    expect(batch.status).toBe(201);

    // Zenith cannot see Apex campaigns.
    expect(
      (await request(app).get(`/api/notifications/campaigns/${now.body.id}`).set(bearer(zenith))).status,
    ).toBe(404);
    const zMsgs = await NotificationMessage.count({
      where: { instituteId: 2, campaignId: { [Op.ne]: null } },
    });
    expect(zMsgs).toBe(0);
  });

  it('limits branch admins to campaigns for their own branch', async () => {
    const app = await getApp();
    const branchAdmin = (await login(USERS.apexBranchAdmin)).accessToken;
    const res = await request(app)
      .post('/api/notifications/campaigns')
      .set(bearer(branchAdmin))
      .send({ title: 'All', channels: ['in_app'], body: 'x', audience: { roles: ['student'] } });
    expect(res.status).toBe(403);
    expect((await request(app).get('/api/notifications/providers').set(bearer(branchAdmin))).status).toBe(
      403,
    );
  });
});
