import { PARENT_MONTHLY_REPORT_EVENT } from '@erp/shared';
import { registerNotificationEvents } from '../notifications/api';

/** Parent-portal's own catalogue entries (consumers plug in via `registerParentPortalProvider`). */
export function registerParentPortalIntegrations(): void {
  registerNotificationEvents([
    {
      key: PARENT_MONTHLY_REPORT_EVENT,
      label: 'Monthly parent report ready',
      category: 'Parent portal',
      variables: ['student', 'period'],
      defaultChannels: ['in_app', 'push', 'email'],
      defaultRecipientTypes: ['guardian'],
      title: 'Monthly report for {{student}}',
      body: "{{student}}'s report for {{period}} is ready in the parent app.",
    },
  ]);
}
