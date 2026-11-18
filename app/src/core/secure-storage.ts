import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';

/**
 * Key/value store for secrets: session tokens, the cached profile, offline content keys and the biometric unlock
 * credential.
 *
 * - iOS: Keychain. Android: values encrypted (AES-GCM) with a key held in the Android Keystore.
 *   Both go through `@capgo/capacitor-native-biometric`, never plain preferences.
 * - Web: Capacitor Preferences (localStorage). Browsers have no hardware key store; web sessions rely on short-lived
 *   access tokens and the server-side inactivity expiry instead.
 */
export const SecureKey = {
  session: 'erp.session',
  profile: 'erp.profile',
  offlineKeys: 'erp.offline.keys',
  biometric: 'erp.biometric',
  /** Stored with biometric access control; read only through `NativeBiometric.getSecureData` (core/biometric.ts). */
  biometricSecret: 'erp.biometric.secret',
} as const;
export type SecureKeyName = (typeof SecureKey)[keyof typeof SecureKey];

/** Lives in plain preferences, which are deleted with the app (unlike iOS Keychain items). */
const INSTALL_MARKER = 'erp.installed';

const isNative = () => Capacitor.isNativePlatform();

let ready: Promise<void> | null = null;

/** iOS keeps Keychain items after the app is deleted: a fresh install must not inherit an old session or credential. */
function init() {
  ready ??= (async () => {
    if ((await Preferences.get({ key: INSTALL_MARKER })).value) return;
    for (const key of Object.values(SecureKey))
      await NativeBiometric.deleteData({ key }).catch(() => undefined);
    await Preferences.set({ key: INSTALL_MARKER, value: '1' });
  })();
  return ready;
}

export async function secureGet(key: SecureKeyName): Promise<string | null> {
  if (!isNative()) return (await Preferences.get({ key })).value;
  await init();
  try {
    return (await NativeBiometric.getData({ key })).value ?? null;
  } catch {
    // Not found, or unreadable (e.g. restored from a backup onto another device): treat as absent.
    return null;
  }
}

export async function secureSet(key: SecureKeyName, value: string): Promise<void> {
  if (!isNative()) return Preferences.set({ key, value });
  await init();
  await NativeBiometric.setData({ key, value });
}

export async function secureRemove(key: SecureKeyName): Promise<void> {
  if (!isNative()) return Preferences.remove({ key });
  await init();
  await NativeBiometric.deleteData({ key }).catch(() => undefined);
}

export async function secureGetJson<T>(key: SecureKeyName): Promise<T | null> {
  const raw = await secureGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const secureSetJson = (key: SecureKeyName, value: unknown) => secureSet(key, JSON.stringify(value));
