import { registerRecipientResolver } from '../notifications/api';
import { getBatchMemberUserIds } from './academics.service';

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
}
