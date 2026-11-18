import { onDeviceRevoked } from '../authentication/api';
import { registerNotificationEvents } from '../notifications/api';
import { disconnectDeviceSockets } from './realtime';

/**
 * Registers live-class notification events not in the platform catalogue, and drops live-class sockets of revoked
 * devices (the handshake only checks the device once); called from `onReady`.
 */
export function registerLiveClassIntegrations(): void {
  onDeviceRevoked('live-classes.sockets', async (e) => {
    disconnectDeviceSockets(e.deviceId);
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
