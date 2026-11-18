import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { BiometryType, NativeBiometric } from '@capgo/capacitor-native-biometric';
import type { BiometricUnlockEnrolmentDto, BiometricUnlockInput, LoginResult } from '@erp/shared';
import { api } from './api';
import { getDeviceDescriptor } from './device';
import {
  SecureKey,
  secureGetJson,
  secureGetProtected,
  secureRemove,
  secureSetJson,
  secureSetProtected,
} from './secure-storage';

/**
 * Biometric unlock (spec 4.18), mobile app only. After a full sign-in the user may turn it on: the
 * server issues a device secret, which the app keeps in the Keychain / Android Keystore behind the OS
 * biometric prompt. Unlocking reads the secret (Face ID / Touch ID / fingerprint) and exchanges it for
 * a new session on this device. Signing out, revoking the device or a change of enrolled
 * fingerprints/faces disables it; password and OTP sign-in always remain available.
 */

/** Biometric unlock set up on this device (in secure storage; the secret itself is stored separately). */
export interface BiometricRecord {
  userId: number;
  deviceId: number;
}

export interface BiometricAvailability {
  available: boolean;
  /** "Face ID", "Touch ID", "Fingerprint"… */
  label: string;
}

export type BiometricFailure = 'cancelled' | 'lockout' | 'invalidated' | 'failed';

export class BiometricError extends Error {
  constructor(
    public reason: BiometricFailure,
    message: string,
  ) {
    super(message);
  }
}

const isNative = () => Capacitor.isNativePlatform();

const LABELS: Partial<Record<BiometryType, string>> = {
  [BiometryType.FACE_ID]: 'Face ID',
  [BiometryType.TOUCH_ID]: 'Touch ID',
  [BiometryType.FINGERPRINT]: 'Fingerprint',
  [BiometryType.FACE_AUTHENTICATION]: 'Face unlock',
  [BiometryType.IRIS_AUTHENTICATION]: 'Iris',
};

export async function biometricAvailability(): Promise<BiometricAvailability> {
  if (!isNative()) return { available: false, label: '' };
  try {
    const r = await NativeBiometric.isAvailable({ useFallback: false });
    return { available: r.isAvailable, label: LABELS[r.biometryType] ?? 'Biometrics' };
  } catch {
    return { available: false, label: '' };
  }
}

/** Maps the plugin's error codes (`BiometricAuthError`, same on iOS and Android). */
export function biometricFailure(e: unknown): BiometricError {
  const code = String((e as { code?: unknown })?.code ?? '');
  const message = (e as Error)?.message ?? '';
  // app/system/user cancel, "use fallback"
  if (['11', '15', '16', '17'].includes(code)) return new BiometricError('cancelled', 'Cancelled');
  if (code === '2' || code === '4')
    return new BiometricError('lockout', 'Too many attempts. Sign in with your password or OTP.');
  // 21 = no protected data: removed by the OS after fingerprints or faces were added or changed
  if (code === '21' || /enrol?lment changed/i.test(message))
    return new BiometricError(
      'invalidated',
      'Biometric unlock was turned off because the fingerprints or faces on this device changed. Sign in with your password or OTP to turn it on again.',
    );
  return new BiometricError('failed', message || 'Biometric check failed');
}

export const getBiometricRecord = () =>
  isNative() ? secureGetJson<BiometricRecord>(SecureKey.biometric) : Promise.resolve(null);

/** Deletes the local credential (the server-side secret is useless without it). */
export async function forgetBiometric() {
  if (!isNative()) return;
  await secureRemove(SecureKey.biometricSecret);
  await secureRemove(SecureKey.biometric);
}

/** Turns biometric unlock on for the signed-in user after a biometric check. */
export async function enableBiometric(userId: number): Promise<BiometricRecord> {
  const { available, label } = await biometricAvailability();
  if (!available) throw new BiometricError('failed', 'Biometric unlock is not available on this device');
  try {
    await NativeBiometric.verifyIdentity({
      reason: `Use ${label} to unlock the app`,
      title: `Turn on ${label}`,
      negativeButtonText: 'Cancel',
      useFallback: false,
      maxAttempts: 3,
    });
  } catch (e) {
    throw biometricFailure(e);
  }
  const enrolment = await api.post<BiometricUnlockEnrolmentDto>('/auth/biometric');
  try {
    await secureSetProtected(SecureKey.biometricSecret, enrolment.secret);
    const record: BiometricRecord = { userId, deviceId: enrolment.deviceId };
    await secureSetJson(SecureKey.biometric, record);
    return record;
  } catch (e) {
    await api.delete('/auth/biometric').catch(() => undefined);
    await forgetBiometric();
    throw e;
  }
}

/** Turns biometric unlock off on this device (server and local credential). */
export async function disableBiometric() {
  await api.delete('/auth/biometric').catch(() => undefined);
  await forgetBiometric();
}

/** Shows the biometric prompt and returns this device's unlock secret. Throws `BiometricError`. */
export async function readUnlockSecret(label: string): Promise<string> {
  try {
    return await secureGetProtected(SecureKey.biometricSecret, {
      reason: 'Unlock ERP Coaching',
      title: `Unlock with ${label}`,
      negativeButtonText: 'Cancel',
      maxAttempts: 3,
    });
  } catch (e) {
    throw biometricFailure(e);
  }
}

/** Exchanges the secret for a new session on this device (`POST /auth/biometric/unlock`). */
export async function exchangeUnlockSecret(
  record: BiometricRecord,
  secret: string,
  instituteId?: number,
): Promise<LoginResult> {
  const { uid } = await getDeviceDescriptor();
  const body: BiometricUnlockInput = { deviceId: record.deviceId, deviceUid: uid, secret, instituteId };
  return api.post<LoginResult>('/auth/biometric/unlock', body, { anonymous: true });
}

const declinedKey = (userId: number) => `erp.biometric.declined.${userId}`;

/** The user answered "Not now" to the offer after signing in; don't ask again (Settings › Devices still has it). */
export const biometricDeclined = async (userId: number) =>
  (await Preferences.get({ key: declinedKey(userId) })).value === '1';
export const setBiometricDeclined = (userId: number) =>
  Preferences.set({ key: declinedKey(userId), value: '1' });
