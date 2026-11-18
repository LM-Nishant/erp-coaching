import { onBeforeUnmount, readonly, ref, watch, type WatchSource } from 'vue';
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PrivacyScreen } from '@capacitor-community/privacy-screen';
import type { CaptureEventInput } from '@erp/shared';
import { api } from './api';
import { toast } from './toast';

/**
 * Screenshot and screen-recording restrictions for protected screens (spec 4.18). Prevention depends on the platform
 * and is never complete (spec 9): nothing stops a second camera. While a protected screen is visible:
 *
 * - Android: FLAG_SECURE. Screenshots and recordings come out black, casting shows nothing and the app switcher shows a
 *   blank card.
 * - iOS: captures cannot be blocked. Recording, mirroring and AirPlay are detected and `<SecureView>` hides its content
 *   until they stop; screenshots are detected after they are taken (warned and audited); the app-switcher snapshot is
 *   replaced by the privacy screen.
 * - Web: nothing can be blocked or detected; the watermark is the only deterrent.
 *
 * Screens opt in with `<SecureView>` (or `useSecureScreen`). Protection is reference-counted, so ordinary screens are
 * unaffected.
 */

interface ScreenCapturePlugin {
  isCaptured(): Promise<{ captured: boolean }>;
}
/** App-local iOS plugin (ios/App/App/ScreenCapturePlugin.swift): whether the screen is being captured right now. */
const ScreenCapture = registerPlugin<ScreenCapturePlugin>('ScreenCapture');

const capturing = ref(false);
const protectedCount = ref(0);
const screens = new Map<symbol, string>();
/** iOS: the screen is being recorded, mirrored or cast. Protected content is hidden meanwhile. */
export const captureActive = readonly(capturing);

let applied = false;
let pending: Promise<void> = Promise.resolve();
let initialised = false;

/** Names of the protected screens currently shown (for capture audit events). */
export function protectedScreens(): string[] {
  return [...new Set(screens.values())];
}

/** Applies the native protection to match the current holders; calls are serialised. */
function sync(): Promise<void> {
  pending = pending.then(async () => {
    const want = screens.size > 0;
    if (!Capacitor.isNativePlatform() || want === applied) return;
    applied = want;
    try {
      await (want ? PrivacyScreen.enable() : PrivacyScreen.disable());
    } catch {
      /* plugin unavailable on this platform */
    }
  });
  return pending;
}

async function refreshCaptured() {
  if (Capacitor.getPlatform() !== 'ios') return;
  try {
    capturing.value = (await ScreenCapture.isCaptured()).captured;
  } catch {
    /* native build without the plugin */
  }
}

/** Protects the screen (named `screen` in audit events) until the returned function is called. */
export function protectScreen(screen: string): () => void {
  const key = Symbol(screen);
  screens.set(key, screen);
  protectedCount.value = screens.size;
  void sync();
  void refreshCaptured();
  return () => {
    if (!screens.delete(key)) return;
    protectedCount.value = screens.size;
    void sync();
  };
}

/** Protects the screen while `active` is true and the calling component is mounted. */
export function useSecureScreen(screen: string, active: WatchSource<boolean> = () => true) {
  let release: (() => void) | null = null;
  const stop = watch(
    active,
    (on) => {
      if (on && !release) release = protectScreen(screen);
      else if (!on && release) {
        release();
        release = null;
      }
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    stop();
    release?.();
    release = null;
  });
}

function report(kind: CaptureEventInput['kind']) {
  const body: CaptureEventInput = { kind, screens: protectedScreens() };
  void api.post('/auth/capture-events', body, { background: true }).catch(() => undefined);
}

/** Listens for iOS capture events (no-op elsewhere). Called once at start-up. */
export function initSecureScreen() {
  if (initialised || !Capacitor.isNativePlatform()) return;
  initialised = true;
  void PrivacyScreen.addListener('screenRecordingStarted', () => (capturing.value = true));
  void PrivacyScreen.addListener('screenRecordingStopped', () => (capturing.value = false));
  void PrivacyScreen.addListener('screenshotTaken', () => {
    if (!protectedCount.value) return;
    report('screenshot');
    void toast('Screenshots of this content are not allowed. This one has been logged.', 'warning');
  });
  void App.addListener('appStateChange', ({ isActive }) => {
    if (isActive && protectedCount.value) void refreshCaptured();
  });
  // A recording that starts on a protected screen, or a protected screen opened during one.
  watch(
    () => capturing.value && protectedCount.value > 0,
    (on) => on && report('recording'),
  );
}
