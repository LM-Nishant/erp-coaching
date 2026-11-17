import { Capacitor } from '@capacitor/core';
import { PrivacyScreen } from '@capacitor-community/privacy-screen';

/** Blocks screenshots/recording (Android FLAG_SECURE, iOS snapshot shield) while protected content is on screen. */
export async function protectScreen(on: boolean) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await (on ? PrivacyScreen.enable() : PrivacyScreen.disable());
  } catch {
    /* plugin unavailable on this platform */
  }
}
