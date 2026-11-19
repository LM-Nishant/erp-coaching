import { ref } from 'vue';
import { Capacitor, registerPlugin } from '@capacitor/core';
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

/** App-local Android plugin (android/app/src/main/java/com/erpcoaching/app/PushConfigPlugin.java). */
const PushConfig = registerPlugin<{ status(): Promise<{ configured: boolean }> }>('PushConfig');

/** Without google-services.json Firebase is not set up and `PushNotifications.register()` crashes the Android app. */
async function firebaseConfigured(): Promise<boolean> {
  try {
    return (await PushConfig.status()).configured;
  } catch {
    return false; // An older native build without the plugin.
  }
}

let registeredFor: number | null = null;
/** The token last sent to the API for `registeredFor`; removed again at sign-out. */
let registeredToken: string | null = null;

/**
 * Registers this device for push once per signed-in user. Native: @capacitor/push-notifications gives an FCM token on
 * Android and the APNs device token on iOS (the push provider sends those to APNs directly). Web: a stable mock token
 * per browser install, so the push channel is testable end to end with the console provider. `openInbox` runs when a
 * push is tapped.
 */
export async function registerPush(userId: number, openInbox: () => void): Promise<void> {
  if (registeredFor === userId) return;
  registeredFor = userId;
  const device = await getDeviceDescriptor();
  const save = async (token: string) => {
    await inboxApi.registerPushToken({ token, platform: device.platform, deviceUid: device.uid });
    if (registeredFor === userId) registeredToken = token;
  };
  try {
    if (!Capacitor.isNativePlatform()) return await save(`web-mock-${device.uid}`);
    if (device.platform === 'android' && !(await firebaseConfigured())) return;
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt') perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    await PushNotifications.removeAllListeners();
    // Fired on every app start (tokens can rotate); the API moves a known token to the user signing in.
    await PushNotifications.addListener('registration', ({ value }) => {
      if (registeredFor === userId) void save(value).catch(() => undefined);
    });
    await PushNotifications.addListener('pushNotificationReceived', () => void refreshUnread());
    await PushNotifications.addListener('pushNotificationActionPerformed', () => openInbox());
    // A failed registration (iOS without the APNs entitlement, no network) only fires `registrationError`; the next
    // app start tries again.
    await PushNotifications.register();
  } catch {
    registeredFor = null;
  }
}

/** Before signing out: this device stops getting the user's pushes. Best effort (offline, the next sign-in takes it over). */
export async function unregisterPush(): Promise<void> {
  const token = registeredToken;
  registeredFor = null;
  registeredToken = null;
  if (Capacitor.isNativePlatform()) await PushNotifications.removeAllListeners().catch(() => undefined);
  if (token) await inboxApi.removePushToken(token).catch(() => undefined);
}
