import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';

export const ADMISSION_COMPLETED_JOB = 'admissions.completed';

export interface AdmissionCompletedEvent {
  applicationId: number;
  /** `students.id` of the admitted student. */
  studentId: number;
  /** Login user id (null for siblings sharing a mobile). */
  studentUserId: number | null;
  branchId: number;
  courseId: number | null;
  batchId: number | null;
}

export type AdmissionCompletedListener = (event: AdmissionCompletedEvent) => Promise<void>;

const listeners = new Map<string, AdmissionCompletedListener>();

/**
 * Other modules (fees, LMS…) subscribe to completed admissions here from their `onReady` hook.
 * Listeners run in a background job with the institute's system context after the admit
 * transaction commits; they must be idempotent (jobs retry).
 */
export function onAdmissionCompleted(name: string, listener: AdmissionCompletedListener): void {
  listeners.set(name, listener);
}

export async function emitAdmissionCompleted(event: AdmissionCompletedEvent): Promise<void> {
  if (!listeners.size) return;
  requireTenantContext();
  await enqueueJob(ADMISSION_COMPLETED_JOB, { ...event });
}

export async function handleAdmissionCompleted(payload: Record<string, unknown>): Promise<void> {
  const event = payload as unknown as AdmissionCompletedEvent;
  const failures: string[] = [];
  for (const [name, listener] of listeners) {
    try {
      await listener(event);
    } catch (err) {
      logger.warn({ listener: name, applicationId: event.applicationId, err }, 'Admission listener failed');
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
