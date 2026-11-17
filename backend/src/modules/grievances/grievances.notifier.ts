import type { JobHandler } from '../../infrastructure/jobs/queue';
import { getContext } from '../../shared/context';
import { notify } from '../notifications/api';

export interface GrievanceNotice {
  title: string;
  body: string;
  ticketId: number;
}

export const GRIEVANCE_ACTIVITY_EVENT = 'grievances.activity';

/**
 * Notifies the given users (minus the actor) about ticket activity through the platform `notify()`
 * API (`grievances.activity` event), so institute rules, templates, channels and preferences apply.
 */
export async function notifyGrievanceUsers(
  userIds: (number | null | undefined)[],
  notice: GrievanceNotice,
): Promise<void> {
  const actor = getContext().userId;
  const ids = [...new Set(userIds.filter((id): id is number => !!id && id !== actor))];
  if (!ids.length) return;
  await notify({
    event: GRIEVANCE_ACTIVITY_EVENT,
    recipients: [{ userIds: ids }],
    data: { title: notice.title, message: notice.body, ticketId: notice.ticketId },
  });
}

/** Drains `grievances.notify` jobs queued before notifications were wired; runs in the job's tenant. */
export const deliverGrievanceNotice: JobHandler = async (payload) => {
  const { userIds, ...notice } = payload as unknown as GrievanceNotice & { userIds: number[] };
  await notify({
    event: GRIEVANCE_ACTIVITY_EVENT,
    recipients: [{ userIds }],
    data: { title: notice.title, message: notice.body, ticketId: notice.ticketId },
  });
};
