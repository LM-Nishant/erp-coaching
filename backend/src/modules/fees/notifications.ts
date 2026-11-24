import {
  guardiansOf,
  notify,
  notifyAmount,
  registerNotificationEvents,
  studentUserOf,
} from '../notifications/api';
import { logger } from '../../infrastructure/logger';

export function registerFeeNotificationEvents() {
  registerNotificationEvents([
    {
      key: 'fees.payment-failed',
      label: 'Fee payment failed',
      category: 'Fees',
      variables: ['student.name', 'amount'],
      title: 'Payment failed',
      body: 'Your online payment of ₹{{amount}} for {{student.name}} did not go through. No money was deducted from the fees account.',
      defaultChannels: ['in_app', 'push'],
      defaultRecipientTypes: ['guardian', 'student'],
    },
    {
      key: 'fees.refund',
      label: 'Fee refund processed',
      category: 'Fees',
      variables: ['student.name', 'amount', 'receiptNo'],
      title: 'Refund processed',
      body: 'A refund of ₹{{amount}} against receipt {{receiptNo}} for {{student.name}} has been processed.',
      defaultChannels: ['in_app', 'push', 'sms'],
      defaultRecipientTypes: ['guardian', 'student'],
    },
    {
      key: 'fees.receipt-share',
      label: 'Fee receipt (shared on WhatsApp)',
      category: 'Fees',
      variables: ['student.name', 'amount', 'receiptNo', 'paidOn', 'receiptUrl'],
      title: 'Fee receipt {{receiptNo}}',
      body: 'Receipt {{receiptNo}}: ₹{{amount}} received for {{student.name}} on {{paidOn}}. Download: {{receiptUrl}}',
      defaultChannels: ['whatsapp'],
      defaultRecipientTypes: ['guardian', 'student'],
    },
    {
      key: 'fees.course-enrolment-pending',
      label: 'Course bought online, batch to assign',
      category: 'Fees',
      variables: ['student.name', 'course', 'reason'],
      title: 'Assign a batch: {{student.name}}',
      body: '{{student.name}} paid for {{course}} online but could not be placed in a batch: {{reason}}. Assign one under Fees → Course enrolments.',
      defaultChannels: ['in_app', 'push'],
      defaultRecipientTypes: ['staff'],
    },
  ]);
}

/** Fire-and-forget wrapper: notification failures never undo a posted payment. */
export async function notifyStudent(
  event: string,
  student: { id: number; name: string },
  data: Record<string, unknown>,
  branchId: number | null,
  channels?: ('in_app' | 'push' | 'sms' | 'whatsapp' | 'email')[],
) {
  try {
    await notify({
      event,
      recipients: [guardiansOf(student.id), studentUserOf(student.id)],
      data: { student: { name: student.name }, ...data },
      branchId,
      ...(channels ? { channels } : {}),
    });
  } catch (err) {
    logger.warn({ event, studentId: student.id, err }, 'Fee notification failed');
  }
}

/** Amount for a `₹{{amount}}` notification variable: `46,250`, `46,250.50`. */
export const money = (paise: number) => notifyAmount(paise);
