import { registerRecipientResolver } from '../notifications/api';
import { setLinkedStudentsResolver } from '../grievances/grievances.links';
import {
  getGuardianUserIds,
  getGuardianUserIdsForStudentUsers,
  getLinkedStudentUsers,
  getStudentUserId,
} from './guardian-access';

/**
 * Registers guardian/student lookups with the modules that consume them. Called from `onReady`
 * (see CONTRIBUTING "Cross-module wiring"): the provider registers into the consumer's extension point.
 */
export function registerGuardianIntegrations(): void {
  registerRecipientResolver('guardiansOf', (studentId, { instituteId }) =>
    getGuardianUserIds(Number(studentId), instituteId),
  );
  registerRecipientResolver('studentUser', async (studentId, { instituteId }) => {
    const userId = await getStudentUserId(Number(studentId), instituteId);
    return userId ? [userId] : [];
  });
  registerRecipientResolver('guardiansOfStudentUsers', (userIds, { instituteId }) =>
    getGuardianUserIdsForStudentUsers((userIds as number[]).map(Number), instituteId),
  );
  // Grievances key students by login user id.
  setLinkedStudentsResolver(async (parentUserId, instituteId) =>
    (await getLinkedStudentUsers(parentUserId, instituteId)).map(({ id, name }) => ({ id, name })),
  );
}
