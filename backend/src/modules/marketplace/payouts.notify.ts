import { SYSTEM_ROLES } from '@erp/shared';
import { logger } from '../../infrastructure/logger';
import { runWithContext } from '../../shared/context';
import { notify, notifyAmount, notifyPlatformUsers, registerNotificationEvents } from '../notifications/api';
import { UserRole } from '../permissions/models';
import type { MktSeller } from './models';

export const PAYOUT_PAID_EVENT = 'marketplace.payout-paid';

export function registerPayoutNotificationEvents() {
  registerNotificationEvents([
    {
      key: PAYOUT_PAID_EVENT,
      label: 'Marketplace payout sent',
      category: 'Marketplace',
      variables: ['amount', 'period', 'reference', 'paidTo', 'seller'],
      defaultChannels: ['in_app', 'push', 'email'],
      defaultRecipientTypes: ['staff', 'user'],
      title: 'Payout of ₹{{amount}} sent',
      body: 'Your marketplace earnings for {{period}} (₹{{amount}}) were sent to {{paidTo}}. Reference: {{reference}}.',
    },
  ]);
}

/**
 * Notifies a seller: an institute storefront's admins, or the independent instructor. notify() is
 * institute-scoped, so an instructor is reached through an institute they belong to; one with none gets
 * it in their personal (platform) inbox. Never throws.
 */
export async function notifySeller(
  seller: MktSeller,
  event: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (seller.ownerInstituteId) {
      const instituteId = seller.ownerInstituteId;
      await runWithContext({ system: true, instituteId, allowedBranchIds: null }, () =>
        notify({
          event,
          recipients: [{ role: SYSTEM_ROLES.INSTITUTE_ADMIN }],
          data: payload,
          branchId: null,
        }),
      );
      return true;
    }
    if (!seller.userId) return false;
    const membership = await UserRole.findOne({
      where: { userId: seller.userId },
      attributes: ['instituteId'],
      order: [['id', 'ASC']],
      // Platform code: the instructor's own memberships, across institutes.
      tenantBypass: true,
    } as Parameters<typeof UserRole.findOne>[0]);
    if (!membership?.instituteId) {
      const r = await notifyPlatformUsers({ event, userIds: [seller.userId], data: payload });
      return r.messageIds.length > 0;
    }
    await runWithContext({ system: true, instituteId: membership.instituteId, allowedBranchIds: null }, () =>
      notify({
        event,
        recipients: [{ userIds: [seller.userId!], type: 'user' }],
        data: payload,
        branchId: null,
      }),
    );
    return true;
  } catch (err) {
    logger.warn({ err, sellerId: seller.id, event }, 'Seller notification failed');
    return false;
  }
}

/** Tells the seller that a payout was sent. */
export function notifyPayoutPaid(
  seller: MktSeller,
  data: { netPaise: number; period: string; reference: string; paidTo: string },
): Promise<boolean> {
  return notifySeller(seller, PAYOUT_PAID_EVENT, {
    amount: notifyAmount(data.netPaise),
    period: data.period,
    reference: data.reference,
    paidTo: data.paidTo,
    seller: seller.displayName,
  });
}
