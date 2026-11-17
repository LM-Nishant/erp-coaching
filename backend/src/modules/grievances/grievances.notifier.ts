import { Op } from 'sequelize';
import { enqueueJob, type JobHandler } from '../../infrastructure/jobs/queue';
import { getMessagingProvider } from '../../infrastructure/messaging';
import { getContext } from '../../shared/context';
import { User } from '../users/user.model';

export interface GrievanceNotice {
  title: string;
  body: string;
  ticketId: number;
}

/**
 * Local notification hook. Until the notifications module ships `notify()`, messages are queued
 * as a `grievances.notify` job and delivered through the messaging adapter. Swap the body of
 * this function for `notify()` later; callers stay unchanged.
 */
export async function notifyGrievanceUsers(
  userIds: (number | null | undefined)[],
  notice: GrievanceNotice,
): Promise<void> {
  const actor = getContext().userId;
  const ids = [...new Set(userIds.filter((id): id is number => !!id && id !== actor))];
  if (!ids.length) return;
  await enqueueJob('grievances.notify', { userIds: ids, ...notice });
}

export const deliverGrievanceNotice: JobHandler = async (payload) => {
  const { userIds, title, body, ticketId } = payload as unknown as GrievanceNotice & { userIds: number[] };
  // users is a global (non-tenant) table; ids were resolved inside the tenant when queued.
  const users = await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'mobile'] });
  const sms = getMessagingProvider('sms');
  for (const u of users) {
    await sms.send({ to: u.mobile, subject: title, body, data: { kind: 'grievance', ticketId } });
  }
};
