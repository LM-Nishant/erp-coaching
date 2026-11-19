import { onDeviceRevoked, onDeviceSignedOut } from '../authentication/api';
import { registerNotificationEvents } from '../notifications/api';
import { onAccessChanged } from '../subscriptions/api';
import { logger } from '../../infrastructure/logger';
import { dropDevice, dropSignedOutDevice, recheckLiveSockets } from './realtime';

/**
 * Registers live-class notification events not in the platform catalogue. Drops the live-class sockets and media
 * connections of devices that sign out or are revoked, and re-checks the sockets of institutes whose subscription
 * or status changed (the handshake only checks them once; the sockets are also re-checked every minute); called
 * from `onReady`.
 */
export function registerLiveClassIntegrations(): void {
  onDeviceRevoked('live-classes.sockets', (e) => dropDevice(e.userId, e.deviceId));
  onDeviceSignedOut('live-classes.sockets', (e) => dropSignedOutDevice(e.userId, e.deviceId));
  onAccessChanged('live-classes.sockets', (instituteId) => {
    recheckLiveSockets(instituteId).catch((err) => logger.error({ err }, 'live socket re-check failed'));
  });
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
