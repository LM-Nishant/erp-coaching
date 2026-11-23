import type { NotificationEventDef } from '@erp/shared';
import { logger } from '../../infrastructure/logger';
import { runWithContext } from '../../shared/context';
import { notify, notifyPlatformUsers, registerNotificationEvents } from '../notifications/api';
import { UserRole } from '../permissions/models';

export const QUESTION_ASKED_EVENT = 'marketplace.question.asked';
export const QUESTION_ANSWERED_EVENT = 'marketplace.question.answered';

/** Catalogue entries must exist before notify() is called. */
export function registerEngagementNotificationEvents() {
  const events: NotificationEventDef[] = [
    {
      key: QUESTION_ASKED_EVENT,
      label: 'Marketplace course question',
      category: 'Course marketplace',
      variables: ['course', 'title', 'learner'],
      defaultChannels: ['in_app', 'push'],
      defaultRecipientTypes: ['user'],
      title: 'New question on {{course}}',
      body: '{{learner}} asked: "{{title}}"',
    },
    {
      key: QUESTION_ANSWERED_EVENT,
      label: 'Marketplace question answered',
      category: 'Course marketplace',
      variables: ['course', 'title', 'author'],
      defaultChannels: ['in_app', 'push'],
      defaultRecipientTypes: ['user'],
      title: 'New answer on {{course}}',
      body: '{{author}} answered your question "{{title}}"',
    },
  ];
  registerNotificationEvents(events);
}

/**
 * Notifications live in an institute's inbox, while marketplace users may belong to several institutes or
 * none. Each recipient is notified in `preferInstituteId` when they are a member there, else in their first
 * institute; users without any institute get it in their personal (platform) inbox.
 * Never throws: a failed notification must not fail the learner's request.
 */
export async function notifyMarketplaceUsers(input: {
  event: string;
  userIds: number[];
  data: Record<string, unknown>;
  preferInstituteId?: number | null;
}): Promise<number> {
  let delivered = 0;
  try {
    const userIds = [...new Set(input.userIds)];
    if (!userIds.length) return 0;
    const memberships = await UserRole.findAll({
      where: { userId: userIds },
      attributes: ['userId', 'instituteId'],
      order: [['id', 'ASC']],
      tenantBypass: true,
    } as object);
    const byInstitute = new Map<number, number[]>();
    const withoutInstitute: number[] = [];
    for (const userId of userIds) {
      const mine = memberships.filter((m) => m.userId === userId).map((m) => m.instituteId);
      const instituteId =
        input.preferInstituteId && mine.includes(input.preferInstituteId) ? input.preferInstituteId : mine[0];
      if (!instituteId) {
        withoutInstitute.push(userId);
        continue;
      }
      byInstitute.set(instituteId, [...(byInstitute.get(instituteId) ?? []), userId]);
    }
    for (const [instituteId, ids] of byInstitute) {
      await runWithContext({ system: true, instituteId, allowedBranchIds: null }, async () => {
        const r = await notify({
          event: input.event,
          recipients: [{ userIds: ids, type: 'user' }],
          data: input.data,
          branchId: null,
        });
        delivered += r.messageIds.length;
      });
    }
    if (withoutInstitute.length) {
      const r = await notifyPlatformUsers({
        event: input.event,
        userIds: withoutInstitute,
        data: input.data,
      });
      delivered += r.messageIds.length;
    }
  } catch (err) {
    logger.warn({ event: input.event, reason: (err as Error).message }, 'Marketplace notification failed');
  }
  return delivered;
}
