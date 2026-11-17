import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import type { ClassSession } from './models';

export const CLASS_COMPLETED_JOB = 'academics.class-completed';

export interface ClassCompletedEvent {
  classSessionId: number;
  batchId: number;
  branchId: number;
  teacherUserId: number;
  date: string;
  actualDurationMinutes: number | null;
}

export type ClassCompletedListener = (event: ClassCompletedEvent) => Promise<void>;

const listeners = new Map<string, ClassCompletedListener>();

/**
 * Other modules (payroll, attendance, reports…) subscribe to completed classes here from their
 * `onReady` hook. Listeners run in a background job with the institute's system context, so a
 * failing listener never fails the teacher's request; they must be idempotent (jobs retry).
 */
export function onClassSessionCompleted(name: string, listener: ClassCompletedListener): void {
  listeners.set(name, listener);
}

export async function emitClassSessionCompleted(session: ClassSession): Promise<void> {
  if (!listeners.size) return;
  requireTenantContext();
  const event: ClassCompletedEvent = {
    classSessionId: session.id,
    batchId: session.batchId,
    branchId: session.branchId,
    teacherUserId: session.teacherUserId,
    date: session.date,
    actualDurationMinutes: session.actualDurationMinutes ?? null,
  };
  await enqueueJob(CLASS_COMPLETED_JOB, { ...event });
}

export async function handleClassCompleted(payload: Record<string, unknown>): Promise<void> {
  const event = payload as unknown as ClassCompletedEvent;
  const failures: string[] = [];
  for (const [name, listener] of listeners) {
    try {
      await listener(event);
    } catch (err) {
      logger.warn(
        { listener: name, classSessionId: event.classSessionId, err },
        'Class-completed listener failed',
      );
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
