import { defineModule } from '../../shared/module';
import { associateNotificationModels, initNotificationModels } from './models';
import { notificationRoutes } from './notifications.routes';
import { CAMPAIGN_JOB, DELIVER_JOB, deliverMessage, runCampaign } from './notify.service';
import { registerNotificationIntegrations } from './integrations';
import { PLATFORM_PUSH_JOB, pushPlatformMessage } from './platform-inbox';
import { initPlatformInboxModels } from './platform-inbox.models';

/**
 * Notifications & communication (spec §4.14). Other modules use the public API exported from
 * `./api` — see CONTRIBUTING.md "Sending notifications".
 */
export default defineModule({
  name: 'notifications',
  models: (sequelize) => {
    initNotificationModels(sequelize);
    initPlatformInboxModels(sequelize);
  },
  associate: associateNotificationModels,
  routes: notificationRoutes,
  permissions: [
    {
      module: 'notifications',
      label: 'Communication (admin)',
      area: 'Communication',
      describe: {
        view: ['View messages sent', 'See announcements, campaigns and delivery reports'],
        create: ['Send announcements', 'Send SMS, WhatsApp, email and app announcements'],
        edit: ['Edit templates', 'Change message templates and scheduled campaigns'],
        configure: ['Messaging setup', 'Automatic alerts and messaging channels'],
      },
      actions: ['view', 'create', 'edit', 'configure'],
      grants: { 'branch-admin': ['view', 'create'] },
    },
    {
      module: 'notification-inbox',
      label: 'My notifications',
      area: 'My account',
      describe: {
        view: ['Read notifications', 'See their own notifications'],
        edit: ['Notification preferences', 'Mark notifications read and choose how to be notified'],
      },
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
    [PLATFORM_PUSH_JOB]: (payload) => pushPlatformMessage(payload as { messageId: number }),
  },
  onReady: registerNotificationIntegrations,
});
