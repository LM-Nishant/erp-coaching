import { ref } from 'vue';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { getDeviceDescriptor } from '@/core/device';
import { inboxApi } from './api';

/** Unread in-app count shared by the bell and the inbox page. */
export const unread = ref(0);

export async function refreshUnread(): Promise<void> {
  try {
    unread.value = (await inboxApi.unreadCount()).unread;
  } catch {
    // Offline or signed out: keep the last known count.
  }
}

let registeredFor: number | null = null;

/**
 * Registers this device for push once per signed-in user. Native: @capacitor/push-notifications (FCM/APNs).
 * Web: a stable mock token per browser install, so the push channel is testable end to end with the console
 * provider.
 */
export async function registerPush(userId: number): Promise<void> {
  if (registeredFor === userId) return;
  registeredFor = userId;
  const device = await getDeviceDescriptor();
  try {
    if (!Capacitor.isNativePlatform()) {
      await inboxApi.registerPushToken({
        token: `web-mock-${device.uid}`,
        platform: 'web',
        deviceUid: device.uid,
      });
      return;
    }
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt') perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener('registration', ({ value }) => {
      void inboxApi.registerPushToken({ token: value, platform: device.platform, deviceUid: device.uid });
    });
    await PushNotifications.addListener('pushNotificationReceived', () => void refreshUnread());
    await PushNotifications.register();
  } catch {
    registeredFor = null;
  }
}
