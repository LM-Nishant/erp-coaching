/**
 * Public notifications API for other modules. Import only from this file:
 *
 *   import { notify, guardiansOf } from '../notifications/api';
 *   await notify({ event: 'fees.receipt', recipients: [guardiansOf(student.id)], data: { amount, receiptNo } });
 */
export { notify, recordDeliveryReceipt, type NotifyInput, type NotifyResult } from './notify.service';
export {
  guardiansOf,
  studentUserOf,
  registerRecipientResolver,
  type RecipientResolver,
  type RecipientSpec,
} from './recipients';
export { registerNotificationEvents } from './catalogue';
