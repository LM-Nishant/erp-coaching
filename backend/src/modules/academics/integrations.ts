import { requireTenantContext } from '../../shared/context';
import { onLiveSessionEnded } from '../live-classes/api';
import { registerRecipientResolver } from '../notifications/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { getBatchMemberUserIds } from './academics.service';
import { completeClassSession } from './class-completion';

/** Registers academics lookups with consumer modules; called from `onReady`. */
export function registerAcademicsIntegrations(): void {
  // Args: a batch id (campaign audiences) or `{ batchId, students?, teachers? }` (`batchMembersOf()`).
  registerRecipientResolver('batchMembers', (args) => {
    const { batchId, ...opts } =
      typeof args === 'object' && args !== null
        ? (args as { batchId: number; students?: boolean; teachers?: boolean })
        : { batchId: Number(args) };
    return getBatchMemberUserIds(Number(batchId), opts);
  });

  // A live class linked to a timetable class completes it (payroll work units, attendance close…).
  // Attendance records the live joins in the same dispatch, before the class-completed job closes
  // the register; any auto-absent left by an earlier close is replaced by live presence.
  onLiveSessionEnded('academics.complete-class', async (e) => {
    if (!e.classSessionId) return;
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'academics'))) return;
    const minutes = Math.round((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 60000);
    await completeClassSession(e.classSessionId, {
      actualDurationMinutes: Math.min(1440, Math.max(1, minutes)),
      completionNotes: 'Completed via live class',
    });
  });
}
