import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Op } from 'sequelize';
import { consoleOutbox } from '../src/infrastructure/messaging';
import { Job } from '../src/infrastructure/jobs/job.model';
import {
  HELD_RUN_AT,
  enqueueJob,
  holdJobs,
  processDueJobs,
  registerJobHandler,
  releaseHeldJobs,
} from '../src/infrastructure/jobs/queue';
import { resumeOutbound, suppressOutbound } from '../src/infrastructure/outbound';
import { runWithContext } from '../src/shared/context';
import { User } from '../src/modules/users/user.model';
import { notify } from '../src/modules/notifications/api';
import { NotificationMessage } from '../src/modules/notifications/models';
import { DELIVER_JOB } from '../src/modules/notifications/notify.service';
import { getApp, idWatermarks, purgeCreatedSince } from './helpers';

const REASON = 'Test: outbound suppressed';
const asApex = <T>(fn: () => Promise<T>) =>
  runWithContext({ system: true, instituteId: 1, allowedBranchIds: null }, fn);
const TABLES = ['jobs', 'notification_messages', 'notification_delivery_attempts'] as const;

describe('outbound suppression and held jobs (used by the demo data seed)', () => {
  let marks: Record<string, number>;
  let studentId: number;
  const ran: string[] = [];

  beforeAll(async () => {
    await getApp();
    marks = await idWatermarks(TABLES);
    studentId = (await User.findOne({ where: { mobile: '9100000005' } }))!.id;
    registerJobHandler('test.held', async (payload, job) => {
      ran.push(String(payload.tag));
      if (payload.tag === 'flaky' && job.attempts === 1) throw new Error('first attempt fails');
      if (payload.tag === 'parent') await enqueueJob('test.held', { tag: 'child' }, { instituteId: null });
    });
  });

  afterEach(() => resumeOutbound());
  afterAll(async () => {
    if (marks) await purgeCreatedSince(marks);
  });

  const receipt = (receiptNo: string) =>
    asApex(() =>
      notify({
        event: 'fees.receipt',
        channels: ['in_app', 'sms'],
        recipients: [{ userIds: [studentId], type: 'student' }],
        data: { amount: 500, student: { name: 'Riya' }, receiptNo, paidOn: '2026-01-01' },
      }),
    );
  const smsSent = (receiptNo: string) => consoleOutbox.some((m) => m.body.includes(`Receipt ${receiptNo}`));

  it('records external notifications as skipped and queues no delivery', async () => {
    suppressOutbound(REASON);
    const result = await receipt('SUP-1');
    expect(result.queued).toBe(0);
    const messages = await NotificationMessage.findAll({ where: { id: result.messageIds, instituteId: 1 } });
    expect(messages.map((m) => [m.channel, m.status, m.lastError]).sort()).toEqual([
      ['in_app', 'delivered', null],
      ['sms', 'skipped', REASON],
    ]);
    expect(await Job.count({ where: { name: DELIVER_JOB, id: { [Op.gt]: marks.jobs } } })).toBe(0);
  });

  it('does not send a message that was queued before suppression began', async () => {
    const result = await receipt('SUP-2');
    expect(result.queued).toBe(1);
    suppressOutbound(REASON);
    await processDueJobs();
    const sms = await NotificationMessage.findOne({
      where: { id: result.messageIds, channel: 'sms', instituteId: 1 },
    });
    expect([sms?.status, sms?.lastError]).toEqual(['skipped', REASON]);
    expect(smsSent('SUP-2')).toBe(false);
  });

  it('holds enqueued jobs from other workers, then runs due ones here and schedules the rest', async () => {
    holdJobs();
    const later = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000); // DATETIME has no ms
    const due = await enqueueJob('test.held', { tag: 'due' }, { instituteId: null });
    const flaky = await enqueueJob('test.held', { tag: 'flaky' }, { instituteId: null, maxAttempts: 2 });
    const parent = await enqueueJob('test.held', { tag: 'parent' }, { instituteId: null });
    const future = await enqueueJob('test.held', { tag: 'future' }, { instituteId: null, runAt: later });
    expect((await Job.findByPk(due.id))!.runAt).toEqual(HELD_RUN_AT);

    await processDueJobs(); // another worker sharing the database
    expect(ran).toEqual([]);

    expect(await releaseHeldJobs()).toEqual({ ran: 5, scheduled: 1 });
    expect(ran).toEqual(['due', 'flaky', 'flaky', 'parent', 'child']);
    for (const id of [due.id, flaky.id, parent.id])
      expect((await Job.findByPk(id))!.status).toBe('completed');
    const scheduled = (await Job.findByPk(future.id))!;
    expect([scheduled.status, scheduled.runAt.getTime()]).toEqual(['pending', later.getTime()]);

    // Holding stopped: new jobs are queued normally again.
    const normal = await enqueueJob('test.held', { tag: 'normal' }, { instituteId: null, runAt: later });
    expect((await Job.findByPk(normal.id))!.runAt.getTime()).toBe(later.getTime());
  });
});
