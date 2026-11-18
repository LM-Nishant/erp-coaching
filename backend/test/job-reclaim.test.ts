import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { Job } from '../src/infrastructure/jobs/job.model';
import { getStorage } from '../src/infrastructure/storage';
import {
  RECLAIMED_ERROR,
  enqueueJob,
  jobQueueSettings,
  processDueJobs,
  reclaimStaleJobs,
  registerJobFailureHandler,
  registerJobHandler,
} from '../src/infrastructure/jobs/queue';
import { EXPIRE_JOB, EXPORT_JOB } from '../src/modules/reports/exports.service';
import { ReportExport } from '../src/modules/reports/models';
import { USERS, bearer, getApp, login, purgeRows } from './helpers';

const JOB = 'test.reclaim';
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('job queue: reclaiming jobs left running by a stopped worker', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  const ran: number[] = [];
  const failed: { id: number; error: string }[] = [];
  const jobIds: number[] = [];
  const exportIds: number[] = [];
  let unregister: () => void;

  /** A job as a crashed worker leaves it: `running`, claimed (attempt counted) `lockedMinutesAgo`. */
  const crashed = async (attempts: number, lockedMinutesAgo: number, maxAttempts = 3) => {
    const job = await enqueueJob(JOB, { n: jobIds.length }, { instituteId: null, maxAttempts });
    await job.update({ status: 'running', attempts, lockedAt: minutesAgo(lockedMinutesAgo) });
    jobIds.push(job.id);
    return job;
  };

  beforeAll(async () => {
    app = await getApp();
    admin = (await login(USERS.apexAdmin)).accessToken;
    registerJobHandler(JOB, async (_payload, job) => {
      ran.push(job.id);
      // Long enough for a heartbeat when the test shortens the lease.
      if (job.payload.slow) await new Promise((r) => setTimeout(r, 1200));
    });
    unregister = registerJobFailureHandler(JOB, async (job, error) => {
      failed.push({ id: job.id, error });
    });
  });

  afterAll(async () => {
    unregister();
    jobQueueSettings.leaseMs = 10 * 60_000;
    if (jobIds.length) await Job.destroy({ where: { id: jobIds } });
    if (exportIds.length) {
      const sequelize = getSequelize();
      await sequelize.query(
        "DELETE FROM jobs WHERE name IN (?) AND JSON_EXTRACT(payload, '$.exportId') IN (?)",
        { replacements: [[EXPORT_JOB, EXPIRE_JOB], exportIds] },
      );
      const exports = await ReportExport.findAll({ where: { id: exportIds, instituteId: 1 } });
      const fileIds = exports.map((e) => e.fileId).filter((id): id is number => id !== null);
      await ReportExport.destroy({ where: { id: exportIds, instituteId: 1 } });
      if (fileIds.length) {
        const [files] = await sequelize.query('SELECT id, storage_key FROM files WHERE id IN (?)', {
          replacements: [fileIds],
        });
        for (const f of files as { storage_key: string }[]) await getStorage().delete(f.storage_key);
        await purgeRows('files', fileIds);
      }
    }
  });

  it('requeues a stale running job with attempts left and fails one on its last attempt', async () => {
    const stale = await crashed(1, 30);
    const fresh = await crashed(1, 1);
    const exhausted = await crashed(3, 30);

    const result = await reclaimStaleJobs();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    await Promise.all([stale, fresh, exhausted].map((j) => j.reload()));
    expect(stale).toMatchObject({
      status: 'pending',
      attempts: 1,
      lockedAt: null,
      lastError: RECLAIMED_ERROR,
    });
    expect(stale.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    // Still within its lease: its worker may be alive, so it is left alone.
    expect(fresh).toMatchObject({ status: 'running', attempts: 1 });
    expect(exhausted).toMatchObject({ status: 'failed', attempts: 3, lastError: RECLAIMED_ERROR });
    expect(failed).toEqual([{ id: exhausted.id, error: RECLAIMED_ERROR }]);

    // The requeued job runs again (counting another attempt) and completes.
    await processDueJobs();
    await stale.reload();
    expect(ran).toContain(stale.id);
    expect(stale).toMatchObject({ status: 'completed', attempts: 2 });
    // Reclaiming again changes nothing.
    await reclaimStaleJobs();
    await exhausted.reload();
    expect(exhausted.status).toBe('failed');
    expect(failed).toHaveLength(1);
  });

  it('keeps the lease of a long-running job fresh with a heartbeat', async () => {
    jobQueueSettings.leaseMs = 3000; // heartbeat every second
    try {
      const job = await enqueueJob(JOB, { slow: true }, { instituteId: null });
      jobIds.push(job.id);
      const run = processDueJobs();
      await new Promise((r) => setTimeout(r, 300));
      await job.reload();
      expect(job.status).toBe('running');
      const claimedAt = job.lockedAt!.getTime();
      await new Promise((r) => setTimeout(r, 1500));
      // Meanwhile the lock was refreshed (or the job already finished and released it).
      await job.reload();
      expect(job.status === 'completed' || job.lockedAt!.getTime() > claimedAt).toBe(true);
      await run;
      await job.reload();
      expect(job.status).toBe('completed');
    } finally {
      jobQueueSettings.leaseMs = 10 * 60_000;
    }
  });

  describe('report exports', () => {
    /** A queued export and its job; the template comes from a real (synchronous) export. */
    const queueExport = async () => {
      const res = await request(app)
        .post('/api/reports/capacity/exports')
        .set(bearer(admin))
        .send({ format: 'csv' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      exportIds.push(res.body.id);
      const template = (await ReportExport.findOne({ where: { id: res.body.id, instituteId: 1 } }))!;
      const exp = await ReportExport.create({
        instituteId: 1,
        userId: template.userId,
        reportKey: template.reportKey,
        format: template.format,
        status: 'queued',
        filters: template.filters,
        scope: template.scope,
        rowCount: null,
        fileId: null,
        fileName: null,
        error: null,
        expiresAt: null,
        completedAt: null,
      });
      exportIds.push(exp.id);
      const job = await enqueueJob(EXPORT_JOB, { exportId: exp.id }, { instituteId: 1, maxAttempts: 3 });
      jobIds.push(job.id);
      return { exportId: exp.id, job };
    };
    const exportRow = (id: number) => ReportExport.findOne({ where: { id, instituteId: 1 } });

    it('re-runs an export whose worker died, so it does not stay running', async () => {
      const { exportId, job } = await queueExport();
      // The worker claimed the job and started the export, then the process died.
      await job.update({ status: 'running', attempts: 1, lockedAt: minutesAgo(30) });
      await ReportExport.update({ status: 'running' }, { where: { id: exportId, instituteId: 1 } });

      await reclaimStaleJobs();
      await processDueJobs();
      expect(await exportRow(exportId)).toMatchObject({ status: 'ready' });
      await job.reload();
      expect(job).toMatchObject({ status: 'completed', attempts: 2 });
    });

    it('marks the export failed when its job is reclaimed on the last attempt', async () => {
      const { exportId, job } = await queueExport();
      await job.update({ status: 'running', attempts: job.maxAttempts, lockedAt: minutesAgo(30) });
      await ReportExport.update({ status: 'running' }, { where: { id: exportId, instituteId: 1 } });

      await reclaimStaleJobs();
      await job.reload();
      expect(job.status).toBe('failed');
      expect(await exportRow(exportId)).toMatchObject({ status: 'failed', error: RECLAIMED_ERROR });
      const res = await request(app).get(`/api/reports/exports/${exportId}`).set(bearer(admin));
      expect(res.body.status).toBe('failed');
    });
  });
});
