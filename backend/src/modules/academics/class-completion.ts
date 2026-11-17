import { audit } from '../../shared/audit/audit.service';
import { BadRequest, Conflict } from '../../shared/errors';
import { repos, today } from './academics.service';
import { emitClassSessionCompleted } from './class-events';
import type { ClassSession } from './models';

export interface CompleteClassOptions {
  actualDurationMinutes: number | null;
  completionNotes?: string | null;
}

/**
 * Marks a class completed, audits it and emits `onClassSessionCompleted` (payroll work units,
 * attendance close…). Callers check access. Re-completing updates the details and re-emits;
 * listeners are idempotent.
 */
export async function applyClassCompletion(session: ClassSession, opts: CompleteClassOptions) {
  if (session.status === 'cancelled') throw Conflict('Cannot complete a cancelled class', 'INVALID_STATE');
  if (session.date > today()) throw BadRequest('Cannot complete a future class');
  const before = session.toJSON();
  await session.update({
    status: 'completed',
    actualDurationMinutes: opts.actualDurationMinutes,
    completionNotes: opts.completionNotes ?? null,
    completedAt: new Date(),
  });
  await audit({
    action: 'class_session.completed',
    entityType: 'ClassSession',
    entityId: session.id,
    metadata: { before, after: session.toJSON() },
  });
  await emitClassSessionCompleted(session);
  return session;
}

/**
 * Cross-module helper (e.g. a linked live class ended): completes a scheduled class. A no-op for
 * classes that are already completed or cancelled, or dated in the future, so it is safe on retries.
 * Needs a tenant context (request or job); no permission check.
 */
export async function completeClassSession(
  classSessionId: number,
  opts: CompleteClassOptions,
): Promise<{ session: ClassSession; completed: boolean }> {
  const session = await repos.classSessions.findById(classSessionId);
  if (session.status !== 'scheduled' || session.date > today()) return { session, completed: false };
  await applyClassCompletion(session, opts);
  return { session, completed: true };
}
