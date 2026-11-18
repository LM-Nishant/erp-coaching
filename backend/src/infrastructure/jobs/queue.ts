import { Op, type Transaction } from 'sequelize';
import { Job } from './job.model';
import { getContext, runWithContext } from '../../shared/context';
import { logger } from '../logger';
import { captureError } from '../error-tracking';
import { getSequelize } from '../database/sequelize';

export type JobHandler<P = Record<string, unknown>> = (payload: P, job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();
let timer: NodeJS.Timeout | null = null;

export function registerJobHandler(name: string, handler: JobHandler): void {
  if (handlers.has(name)) throw new Error(`Job handler already registered: ${name}`);
  handlers.set(name, handler);
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
  return Job.create(
    {
      name,
      payload,
      instituteId: opts.instituteId !== undefined ? opts.instituteId : (getContext().instituteId ?? null),
      runAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 5,
      lockedAt: null,
      lastError: null,
      completedAt: null,
    },
    { transaction: opts.transaction },
  );
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
  try {
    if (!handler) throw new Error(`No handler registered for job ${job.name}`);
    await runWithContext(
      { system: true, instituteId: job.instituteId ?? undefined, allowedBranchIds: null },
      () => handler(job.payload, job),
    );
    await job.update({ status: 'completed', completedAt: new Date(), lockedAt: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retry = job.attempts < job.maxAttempts;
    const backoffMs = Math.min(2 ** job.attempts * 1000, 15 * 60 * 1000);
    await job.update({
      status: retry ? 'pending' : 'failed',
      lastError: message.slice(0, 4000),
      lockedAt: null,
      runAt: retry ? new Date(Date.now() + backoffMs) : job.runAt,
    });
    logger.warn({ job: job.name, id: job.id, attempt: job.attempts, retry }, `Job failed: ${message}`);
    if (!retry)
      captureError(err, { source: 'job', job: job.name, jobId: job.id, instituteId: job.instituteId });
  }
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
  timer = null;
}
