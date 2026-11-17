import { registerNotificationEvents } from '../notifications/api';

/** Registers live-class notification events not in the platform catalogue; called from `onReady`. */
export function registerLiveClassIntegrations(): void {
  registerNotificationEvents([
    {
      key: 'live-classes.recording-ready',
      label: 'Live class recording available',
      category: 'Live classes',
      variables: ['title'],
      defaultChannels: ['in_app', 'push'],
      defaultRecipientTypes: ['student'],
      title: 'Recording available',
      body: 'The recording of "{{title}}" is now available.',
    },
  ]);
}
