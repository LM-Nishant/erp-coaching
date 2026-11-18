/**
 * Device sessions, inactivity logout and biometric unlock (spec 4.18).
 */

/** Institute setting: minutes without activity before web and app sessions lock. 0 = never. */
export const INSTITUTE_IDLE_TIMEOUT_SETTING = 'security.idle_timeout_minutes';
export const IDLE_TIMEOUT_MIN_MINUTES = 5;
export const IDLE_TIMEOUT_MAX_MINUTES = 1440;
/** Choices offered in the institute settings UI (any value accepted by `isValidIdleTimeout` works). */
export const IDLE_TIMEOUT_CHOICES = [0, 5, 10, 15, 30, 60, 120, 240, 480] as const;

/** 0 (disabled) or a whole number of minutes between 5 and 1440. */
export function isValidIdleTimeout(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    (v === 0 || (v >= IDLE_TIMEOUT_MIN_MINUTES && v <= IDLE_TIMEOUT_MAX_MINUTES))
  );
}

export type DevicePlatform = 'web' | 'android' | 'ios';

/** A sign-in device (`GET /auth/devices`, `GET /users/:id/devices`, `GET /admin/users/:id/devices`). */
export interface DeviceDto {
  id: number;
  name: string | null;
  platform: string | null;
  status: 'active' | 'revoked';
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Biometric unlock is set up on this device. */
  biometricUnlock: boolean;
  /** `GET /auth/devices` only: the device making the request. */
  current?: boolean;
}

/** Session rules for the signed-in user on this device (`MeDto.session`). */
export interface SessionPolicyDto {
  /** Lock / sign out after this many minutes without activity; 0 = never. */
  idleTimeoutMinutes: number;
  /** Biometric unlock is set up for this user on the current device. */
  biometricUnlock: boolean;
}

/** `POST /auth/biometric`: the device secret the app keeps behind the OS biometric prompt. */
export interface BiometricUnlockEnrolmentDto {
  deviceId: number;
  secret: string;
}

/** `POST /auth/biometric/unlock` (public): exchanges the device secret for a new session. */
export interface BiometricUnlockInput {
  deviceId: number;
  deviceUid: string;
  secret: string;
  instituteId?: number;
}

/** A user in the device-management search (`GET /users/devices`: members the admin may manage). */
export interface DeviceUserDto {
  id: number;
  name: string;
  mobile: string;
  email: string | null;
  status: string;
  activeDevices: number;
}

/** `GET /admin/users` (super admin): platform-wide user search for device management. */
export interface PlatformUserDto extends DeviceUserDto {
  isSuperAdmin: boolean;
  /** Institutes the user belongs to. */
  institutes: { id: number; name: string }[];
}

/** Protected screens (`<SecureView screen="…">`): lowercase words joined by hyphens. */
export const SECURE_SCREEN_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * `POST /auth/capture-events`: the app saw a screenshot or a screen recording / mirroring session while protected
 * content was on screen (iOS reports both; Android blocks them with FLAG_SECURE; web cannot detect them). Audited.
 */
export interface CaptureEventInput {
  kind: 'screenshot' | 'recording';
  /** Protected screens visible at the time, e.g. `exam-attempt`. */
  screens: string[];
}
