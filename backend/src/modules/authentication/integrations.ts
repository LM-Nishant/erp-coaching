import { registerNotificationEvents } from '../notifications/api';
import { DEVICE_REVOKED_EVENT } from './devices.service';

/** Registers authentication with provider modules; called from `onReady`. */
export function registerAuthenticationIntegrations(): void {
  registerNotificationEvents([
    {
      key: DEVICE_REVOKED_EVENT,
      label: 'Device signed out by an administrator',
      category: 'Security',
      variables: ['device', 'revokedAt'],
      defaultChannels: ['in_app', 'push'],
      defaultRecipientTypes: ['user'],
      title: 'A device was signed out',
      body: 'An administrator signed your account out of {{device}} at {{revokedAt}}. Offline downloads on that device have been removed. Contact your institute if you did not expect this.',
      mandatory: true,
    },
  ]);
}
