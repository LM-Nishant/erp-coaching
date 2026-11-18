import { onDeviceRevoked } from '../authentication/api';
import { PushToken } from './models';

/** Registers notifications with provider modules; called from `onReady`. */
export function registerNotificationIntegrations(): void {
  // A revoked device stops receiving pushes. Devices are not tenant-scoped, so its push tokens are
  // removed in every institute (system job, no tenant context).
  onDeviceRevoked('notifications.push-tokens', async (e) => {
    await PushToken.destroy({
      where: { userId: e.userId, deviceUid: e.deviceUid },
      tenantBypass: true,
    } as Parameters<typeof PushToken.destroy>[0]);
  });
}
