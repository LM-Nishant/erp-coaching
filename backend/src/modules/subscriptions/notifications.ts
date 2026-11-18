import { SYSTEM_ROLES } from '@erp/shared';
import { logger } from '../../infrastructure/logger';
import { runWithContext } from '../../shared/context';
import { notify, registerNotificationEvents } from '../notifications/api';

const staff = (key: string, label: string, variables: string[], title: string, body: string) => ({
  key,
  label,
  category: 'Billing',
  variables,
  title,
  body,
  defaultChannels: ['in_app', 'push', 'email'] as ('in_app' | 'push' | 'email')[],
  defaultRecipientTypes: ['staff' as const],
});

export function registerBillingNotificationEvents() {
  registerNotificationEvents([
    staff(
      'subscriptions.invoice-issued',
      'Subscription invoice issued',
      ['invoiceNo', 'amount', 'dueDate'],
      'Subscription invoice {{invoiceNo}}',
      'Invoice {{invoiceNo}} for ₹{{amount}} is due on {{dueDate}}. Pay it from Subscription & billing to continue without interruption.',
    ),
    staff(
      'subscriptions.trial-ending',
      'Free trial ending',
      ['plan', 'endsAt'],
      'Your free trial ends on {{endsAt}}',
      'Your {{plan}} trial ends on {{endsAt}}. Pay the subscription invoice from Subscription & billing to keep using the app.',
    ),
    staff(
      'subscriptions.expired',
      'Subscription expired (grace period)',
      ['plan', 'endsAt', 'graceEndsAt'],
      'Your subscription has expired',
      'Your {{plan}} subscription ended on {{endsAt}}. Renew before {{graceEndsAt}} to avoid interruption.',
    ),
    staff(
      'subscriptions.restricted',
      'Subscription lapsed (read-only)',
      ['plan', 'suspendsAt'],
      'Your account is read-only',
      'Your subscription has lapsed and the app is read-only until it is renewed. Renew from Subscription & billing to restore full access.',
    ),
    staff(
      'subscriptions.suspended',
      'Account suspended',
      ['message'],
      'Your account is suspended',
      '{{message}}',
    ),
    staff(
      'subscriptions.payment-received',
      'Subscription payment received',
      ['invoiceNo', 'amount'],
      'Payment received',
      '₹{{amount}} was received against invoice {{invoiceNo}}. Thank you.',
    ),
    staff(
      'subscriptions.payment-failed',
      'Subscription payment failed',
      ['invoiceNo', 'amount'],
      'Payment failed',
      'Your payment of ₹{{amount}} for invoice {{invoiceNo}} did not go through. No money was charged.',
    ),
  ]);
}

/** Notifies the institute's admins; failures are logged, never thrown (billing must not roll back). */
export async function notifyInstituteAdmins(
  instituteId: number,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await runWithContext({ system: true, instituteId, allowedBranchIds: null }, () =>
      notify({ event, recipients: [{ role: SYSTEM_ROLES.INSTITUTE_ADMIN }], data, branchId: null }),
    );
  } catch (err) {
    logger.warn({ err, event, instituteId }, 'Billing notification failed');
  }
}
