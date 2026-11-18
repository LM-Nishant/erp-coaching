import { registerNotificationEvents } from '../notifications/api';
import { EXPORT_READY_EVENT } from './exports.service';

/** Registers the reports notification events; called from `onReady`. */
export function registerReportIntegrations(): void {
  registerNotificationEvents([
    {
      key: EXPORT_READY_EVENT,
      label: 'Report export ready',
      category: 'Reports',
      variables: ['title', 'format', 'fileName'],
      defaultChannels: ['in_app'],
      defaultRecipientTypes: ['user'],
      title: 'Your export is ready',
      body: 'Your {{format}} export of "{{title}}" is ready to download for the next 24 hours.',
    },
  ]);
}
