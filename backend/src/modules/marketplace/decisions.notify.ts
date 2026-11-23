import { registerNotificationEvents } from '../notifications/api';
import { notifyMarketplaceUsers } from './engagement.notifications';
import type { MktCourse, MktSeller } from './models';
import { notifySeller } from './payouts.notify';

export const REFUND_REFUNDED_EVENT = 'marketplace.refund.refunded';
export const REFUND_REJECTED_EVENT = 'marketplace.refund.rejected';
export const REFUND_FAILED_EVENT = 'marketplace.refund.failed';
export const COURSE_APPROVED_EVENT = 'marketplace.course.approved';
export const COURSE_REJECTED_EVENT = 'marketplace.course.rejected';

export function registerDecisionNotificationEvents() {
  registerNotificationEvents([
    {
      category: 'Course marketplace',
      defaultChannels: ['in_app', 'push'],
      key: REFUND_REFUNDED_EVENT,
      label: 'Marketplace refund sent',
      variables: ['amount', 'order', 'course'],
      defaultRecipientTypes: ['user'],
      title: 'Refund of ₹{{amount}} sent',
      body: 'We refunded ₹{{amount}} for {{course}} (order {{order}}). It can take 5 to 7 working days to reach you.',
    },
    {
      category: 'Course marketplace',
      defaultChannels: ['in_app', 'push'],
      key: REFUND_REJECTED_EVENT,
      label: 'Marketplace refund declined',
      variables: ['amount', 'order', 'course', 'note'],
      defaultRecipientTypes: ['user'],
      title: 'Refund request declined',
      body: 'Your refund request for {{course}} (order {{order}}) was declined: {{note}}',
    },
    {
      category: 'Course marketplace',
      defaultChannels: ['in_app', 'push'],
      key: REFUND_FAILED_EVENT,
      label: 'Marketplace refund delayed',
      variables: ['amount', 'order', 'course'],
      defaultRecipientTypes: ['user'],
      title: 'Your refund is delayed',
      body: 'Your refund of ₹{{amount}} for {{course}} (order {{order}}) was approved, but the payment gateway could not send it yet. We will retry it.',
    },
    {
      category: 'Course marketplace',
      defaultChannels: ['in_app', 'push'],
      key: COURSE_APPROVED_EVENT,
      label: 'Marketplace course approved',
      variables: ['course', 'note'],
      defaultRecipientTypes: ['staff', 'user'],
      title: '{{course}} is live',
      body: 'Your course {{course}} was approved and is now on sale in the marketplace.',
    },
    {
      category: 'Course marketplace',
      defaultChannels: ['in_app', 'push'],
      key: COURSE_REJECTED_EVENT,
      label: 'Marketplace course changes requested',
      variables: ['course', 'note'],
      defaultRecipientTypes: ['staff', 'user'],
      title: 'Changes requested on {{course}}',
      body: 'Your course {{course}} needs changes before it can go on sale: {{note}}',
    },
  ]);
}

const rupees = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });

/** Tells the learner how their refund was decided. Never throws. */
export function notifyRefundDecision(
  event: typeof REFUND_REFUNDED_EVENT | typeof REFUND_REJECTED_EVENT | typeof REFUND_FAILED_EVENT,
  input: {
    userId: number;
    amountPaise: number;
    orderNumber: string;
    course: string | null;
    note?: string | null;
  },
) {
  return notifyMarketplaceUsers({
    event,
    userIds: [input.userId],
    data: {
      amount: rupees(input.amountPaise),
      order: input.orderNumber,
      course: input.course ?? 'your order',
      note: input.note ?? '',
    },
  });
}

/** Tells the seller that their course was approved or sent back. Never throws. */
export function notifyCourseDecision(
  seller: MktSeller,
  course: MktCourse,
  approved: boolean,
  note: string | null,
) {
  return notifySeller(seller, approved ? COURSE_APPROVED_EVENT : COURSE_REJECTED_EVENT, {
    course: course.title,
    note: note ?? '',
  });
}
