import { defineModule } from '../../shared/module';
import { associateNotificationModels, initNotificationModels } from './models';
import { notificationRoutes } from './notifications.routes';
import { CAMPAIGN_JOB, DELIVER_JOB, deliverMessage, runCampaign } from './notify.service';
import { registerNotificationIntegrations } from './integrations';

/**
 * Notifications & communication (spec §4.14). Other modules use the public API exported from
 * `./api` — see CONTRIBUTING.md "Sending notifications".
 */
export default defineModule({
  name: 'notifications',
  models: initNotificationModels,
  associate: associateNotificationModels,
  routes: notificationRoutes,
  permissions: [
    {
      module: 'notifications',
      label: 'Communication (admin)',
      actions: ['view', 'create', 'edit', 'configure'],
      grants: { 'branch-admin': ['view', 'create'] },
    },
    {
      module: 'notification-inbox',
      label: 'My notifications',
      actions: ['view', 'edit'],
      grants: {
        'branch-admin': 'all',
        accountant: 'all',
        teacher: 'all',
        student: 'all',
        parent: 'all',
      },
    },
  ],
  jobs: {
    [DELIVER_JOB]: (payload) => deliverMessage(payload as { messageId: number }),
    [CAMPAIGN_JOB]: (payload) => runCampaign(payload as { campaignId: number }),
  },
  onReady: registerNotificationIntegrations,
});
