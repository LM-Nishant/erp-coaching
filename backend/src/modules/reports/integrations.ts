import { registerJobFailureHandler } from '../../infrastructure/jobs/queue';
import { registerNotificationEvents } from '../notifications/api';
import { EXPORT_JOB, EXPORT_READY_EVENT, failExportJob } from './exports.service';

/** Registers the reports notification events and export job cleanup; called from `onReady`. */
export function registerReportIntegrations(): void {
  // A reclaimed or exhausted export job marks its export failed rather than leaving it `running`.
  registerJobFailureHandler(EXPORT_JOB, failExportJob);
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
