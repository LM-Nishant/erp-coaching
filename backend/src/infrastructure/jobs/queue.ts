import { Op, type InferAttributes, type Transaction } from 'sequelize';
import { Job } from './job.model';
import { getContext, runWithContext } from '../../shared/context';
import { logger } from '../logger';
import { captureError } from '../error-tracking';
import { getSequelize } from '../database/sequelize';

export type JobHandler<P = Record<string, unknown>> = (payload: P, job: Job) => Promise<void>;
/** Called once a job has failed for good (attempts exhausted, or its worker died on the last attempt). */
export type JobFailureHandler = (job: Job, error: string) => Promise<void>;

const handlers = new Map<string, JobHandler>();
const failureHandlers = new Map<string, JobFailureHandler[]>();
let timer: NodeJS.Timeout | null = null;
let reclaimTimer: NodeJS.Timeout | null = null;

/**
 * Crash recovery. A running job refreshes `locked_at` every `leaseMs / 3`; a `running` job whose
 * lock is older than `leaseMs` lost its worker (crash, restart, deploy) and is reclaimed: requeued
 * if it has attempts left, otherwise failed. Reclaim runs when the worker starts and every
 * `reclaimIntervalMs`.
 */
export const jobQueueSettings = { leaseMs: 10 * 60_000, reclaimIntervalMs: 60_000 };

export const RECLAIMED_ERROR = 'Worker stopped while the job was running (lease expired)';

export function registerJobHandler(name: string, handler: JobHandler): void {
  if (handlers.has(name)) throw new Error(`Job handler already registered: ${name}`);
  handlers.set(name, handler);
}

/**
 * Registers cleanup for a job that will not run again, for example marking the record it was
 * producing as failed. Handlers must be idempotent; their errors are logged, not rethrown.
 */
export function registerJobFailureHandler(name: string, handler: JobFailureHandler): () => void {
  const list = failureHandlers.get(name) ?? [];
  list.push(handler);
  failureHandlers.set(name, list);
  return () => {
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  };
}

async function onJobFailed(job: Job, error: string): Promise<void> {
  for (const handler of failureHandlers.get(job.name) ?? []) {
    try {
      await runWithContext(
        { system: true, instituteId: job.instituteId ?? undefined, allowedBranchIds: null },
        () => handler(job, error),
      );
    } catch (err) {
      logger.error({ err, job: job.name, id: job.id }, 'Job failure handler failed');
    }
  }
}

/**
 * Enqueue a background job. The current tenant is captured and restored when the job runs,
 * so handlers can use TenantRepository as in a request. Pass `transaction` to commit the job
 * atomically with the change that triggers it (it is discarded if that transaction rolls back).
 */
export async function enqueueJob(
  name: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; maxAttempts?: number; instituteId?: number | null; transaction?: Transaction } = {},
): Promise<Job> {
  const runAt = opts.runAt ?? new Date();
  const job = await Job.create(
    {
      name,
      payload,
      instituteId: opts.instituteId !== undefined ? opts.instituteId : (getContext().instituteId ?? null),
      runAt: held ? HELD_RUN_AT : runAt,
      maxAttempts: opts.maxAttempts ?? 5,
      lockedAt: null,
      lastError: null,
      completedAt: null,
    },
    { transaction: opts.transaction },
  );
  held?.set(job.id, runAt);
  return job;
}

/** Placeholder `run_at` for held jobs: far enough ahead that no worker claims them. */
export const HELD_RUN_AT = new Date('2999-01-01T00:00:00Z');
/** Held job id → the `run_at` it was enqueued with. */
let held: Map<number, Date> | null = null;

/**
 * Holds every job this process enqueues from now on: it is stored with `HELD_RUN_AT`, so no other
 * worker (for example a running API server sharing the database) can claim it. `releaseHeldJobs`
 * then runs the due ones in this process and gives the rest their real `run_at`.
 */
export function holdJobs(): void {
  held ??= new Map();
}

/**
 * Runs held jobs that are due, in this process and in id order, including any jobs they enqueue;
 * a job that fails and has attempts left is retried here too. Jobs scheduled for later are released
 * to the normal queue with their original `run_at`. Stops holding. Returns how many ran and how
 * many were released for later.
 */
export async function releaseHeldJobs(): Promise<{ ran: number; scheduled: number }> {
  let ran = 0;
  let scheduled = 0;
  while (held?.size) {
    const [id, runAt] = [...held].sort(([a], [b]) => a - b)[0];
    held.delete(id);
    if (runAt.getTime() > Date.now()) {
      const [count] = await Job.update({ runAt }, { where: { id, status: 'pending' } });
      scheduled += count;
      continue;
    }
    const job = await Job.findOne({ where: { id, status: 'pending' } });
    if (!job) continue; // rolled back with its transaction, or already handled
    const [claimed] = await Job.update(
      { status: 'running', lockedAt: new Date(), attempts: job.attempts + 1, runAt },
      { where: { id, status: 'pending', attempts: job.attempts } },
    );
    if (!claimed) continue;
    await job.reload();
    await execute(job);
    ran++;
    // Failed with attempts left: execute() requeued it for any worker; keep it here instead.
    const [requeued] = await Job.update({ runAt: HELD_RUN_AT }, { where: { id, status: 'pending' } });
    if (requeued) held.set(id, new Date());
  }
  held = null;
  return { ran, scheduled };
}

async function claimNext(): Promise<Job | null> {
  return getSequelize().transaction(async (transaction) => {
    const job = await Job.findOne({
      where: { status: 'pending', runAt: { [Op.lte]: new Date() } },
      order: [
        ['runAt', 'ASC'],
        ['id', 'ASC'],
      ],
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    if (!job) return null;
    await job.update(
      { status: 'running', lockedAt: new Date(), attempts: job.attempts + 1 },
      { transaction },
    );
    return job;
  });
}

async function execute(job: Job): Promise<void> {
  const handler = handlers.get(job.name);
  // Fencing: every write is conditional on this claim still owning the job. If the lease was
  // reclaimed (and possibly claimed again), this worker's late writes must not touch the new attempt.
  const owned = { id: job.id, status: 'running' as const, attempts: job.attempts };
  const writeOwned = async (values: Partial<InferAttributes<Job>>): Promise<boolean> => {
    const [count] = await Job.update(values, { where: owned });
    if (count === 0)
      logger.warn({ job: job.name, id: job.id, attempt: job.attempts }, 'Job lease lost; result discarded');
    return count > 0;
  };
  // Heartbeat: keep the lease while the handler runs so long jobs (transcodes) are not reclaimed.
  const heartbeat = setInterval(
    () => {
      Job.update({ lockedAt: new Date() }, { where: owned }).catch((err) =>
        logger.warn({ err, job: job.name, id: job.id }, 'Job heartbeat failed'),
      );
    },
    Math.max(1000, Math.floor(jobQueueSettings.leaseMs / 3)),
  );
  heartbeat.unref();
  try {
    if (!handler) throw new Error(`No handler registered for job ${job.name}`);
    await runWithContext(
      { system: true, instituteId: job.instituteId ?? undefined, allowedBranchIds: null },
      () => handler(job.payload, job),
    );
    await writeOwned({ status: 'completed', completedAt: new Date(), lockedAt: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retry = job.attempts < job.maxAttempts;
    const backoffMs = Math.min(2 ** job.attempts * 1000, 15 * 60 * 1000);
    const stillOwned = await writeOwned({
      status: retry ? 'pending' : 'failed',
      lastError: message.slice(0, 4000),
      lockedAt: null,
      runAt: retry ? new Date(Date.now() + backoffMs) : job.runAt,
    });
    if (!stillOwned) return;
    logger.warn({ job: job.name, id: job.id, attempt: job.attempts, retry }, `Job failed: ${message}`);
    if (!retry) {
      captureError(err, { source: 'job', job: job.name, jobId: job.id, instituteId: job.instituteId });
      await onJobFailed(job, message);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Recovers jobs left `running` by a worker that stopped (see `jobQueueSettings`). Returns how many
 * were requeued and failed.
 */
export async function reclaimStaleJobs(now = new Date()): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(now.getTime() - jobQueueSettings.leaseMs);
  const failed: Job[] = [];
  let requeued = 0;
  await getSequelize().transaction(async (transaction) => {
    const stale = await Job.findAll({
      where: {
        status: 'running',
        [Op.or]: [{ lockedAt: { [Op.lt]: cutoff } }, { lockedAt: null }],
      },
      order: [['id', 'ASC']],
      limit: 500,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });
    for (const job of stale) {
      const retry = job.attempts < job.maxAttempts;
      await job.update(
        {
          status: retry ? 'pending' : 'failed',
          lockedAt: null,
          lastError: RECLAIMED_ERROR,
          runAt: retry ? now : job.runAt,
        },
        { transaction },
      );
      if (retry) requeued++;
      else failed.push(job);
    }
  });
  for (const job of failed) await onJobFailed(job, RECLAIMED_ERROR);
  if (requeued || failed.length)
    logger.warn({ requeued, failed: failed.length }, 'Reclaimed jobs left running by a stopped worker');
  return { requeued, failed: failed.length };
}

/** Processes due jobs until none remain (or `max` reached). Used by the worker and tests. */
export async function processDueJobs(max = 50): Promise<number> {
  let processed = 0;
  while (processed < max) {
    const job = await claimNext();
    if (!job) break;
    await execute(job);
    processed++;
  }
  return processed;
}

export function startJobWorker(intervalMs: number): void {
  if (timer) return;
  const reclaim = () =>
    reclaimStaleJobs().catch((err) => logger.error({ err }, 'Reclaiming stale jobs failed'));
  void reclaim();
  reclaimTimer = setInterval(reclaim, jobQueueSettings.reclaimIntervalMs);
  reclaimTimer.unref();
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await processDueJobs();
    } catch (err) {
      logger.error({ err }, 'Job worker error');
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
  logger.info(`Job worker started (${handlers.size} handlers)`);
}

export function stopJobWorker(): void {
  if (timer) clearInterval(timer);
  if (reclaimTimer) clearInterval(reclaimTimer);
  timer = null;
  reclaimTimer = null;
}
