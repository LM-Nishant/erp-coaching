import { Batch } from '../academics/api';
import type { LiveSession } from './models';

export interface LiveEntitlementQuery {
  instituteId: number;
  /** Login user id of the student. */
  studentUserId: number;
  sessionId: number;
  batchId: number;
  /** The session's course, else its batch's course. */
  courseId: number | null;
}

/**
 * Extension point for the module that sells courses (fees): may a student join a (paid) live
 * class? Register from the provider's `integrations.ts` in `onReady`:
 *
 *   import { setLiveEntitlementProvider } from '../live-classes/api';
 *   setLiveEntitlementProvider(async (q) => ...paid up for q.courseId?);
 *
 * Default (no provider): allowed — batch membership is still checked by live classes itself.
 */
export type LiveEntitlementProvider = (q: LiveEntitlementQuery) => Promise<boolean>;

let provider: LiveEntitlementProvider | null = null;

export function setLiveEntitlementProvider(p: LiveEntitlementProvider | null): void {
  provider = p;
}

export async function canJoinLive(session: LiveSession, studentUserId: number): Promise<boolean> {
  if (!provider) return true;
  const courseId =
    session.courseId ??
    (
      await Batch.findOne({
        where: { instituteId: session.instituteId, id: session.batchId },
        attributes: ['courseId'],
      })
    )?.courseId ??
    null;
  return provider({
    instituteId: session.instituteId,
    studentUserId,
    sessionId: session.id,
    batchId: session.batchId,
    courseId,
  });
}
