import { onDeviceRevoked } from '../authentication/api';
import { registerNotificationEvents } from '../notifications/api';
import { onAccessChanged } from '../subscriptions/api';
import { logger } from '../../infrastructure/logger';
import { disconnectDeviceSockets, recheckLiveSockets } from './realtime';

/**
 * Registers live-class notification events not in the platform catalogue, and drops live-class sockets of revoked
 * devices and of institutes whose subscription or status changed (the handshake only checks them once; the sockets
 * are also re-checked every minute); called from `onReady`.
 */
export function registerLiveClassIntegrations(): void {
  onDeviceRevoked('live-classes.sockets', async (e) => {
    disconnectDeviceSockets(e.deviceId);
  });
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
