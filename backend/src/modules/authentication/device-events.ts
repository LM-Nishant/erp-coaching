import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';

export const DEVICE_REVOKED_JOB = 'authentication.device-revoked';
export const DEVICE_SIGNED_OUT_JOB = 'authentication.device-signed-out';

/** A sign-in device was revoked by its user, an institute/branch admin or the super admin. */
export interface DeviceRevokedEvent {
  deviceId: number;
  userId: number;
  /** Client-generated install id (push tokens are keyed by it). */
  deviceUid: string;
  platform: string | null;
  revokedBy: number;
  revokedAt: string;
}

/**
 * Every session on a device ended without revoking the device: its user signed out, it was signed out after
 * inactivity, or a reused refresh token ended its sessions. It may be signed in again later.
 */
export interface DeviceSignedOutEvent {
  deviceId: number;
  /** The user whose session it was. */
  userId: number;
  signedOutAt: string;
}

type Listener<E> = (event: E) => Promise<void>;
const revokedListeners = new Map<string, Listener<DeviceRevokedEvent>>();
const signedOutListeners = new Map<string, Listener<DeviceSignedOutEvent>>();

/**
 * Subscribe (from your module's `integrations.ts`) to device revocations, e.g. to revoke offline
 * licences or push tokens of that device. Devices are not tenant-scoped, so listeners run in a
 * background job without an institute context and act across institutes. They must be
 * idempotent: the job retries when any listener throws.
 */
export function onDeviceRevoked(name: string, listener: Listener<DeviceRevokedEvent>): void {
  revokedListeners.set(name, listener);
}

/**
 * Subscribe to sign-outs, e.g. to drop connections that outlive the access token. Same rules as
 * `onDeviceRevoked`; the device may be signed in again by the time the job runs.
 */
export function onDeviceSignedOut(name: string, listener: Listener<DeviceSignedOutEvent>): void {
  signedOutListeners.set(name, listener);
}

export async function emitDeviceRevoked(event: DeviceRevokedEvent): Promise<void> {
  if (!revokedListeners.size) return;
  await enqueueJob(DEVICE_REVOKED_JOB, { ...event }, { instituteId: null });
}

export async function emitDeviceSignedOut(event: DeviceSignedOutEvent): Promise<void> {
  if (!signedOutListeners.size) return;
  await enqueueJob(DEVICE_SIGNED_OUT_JOB, { ...event }, { instituteId: null });
}

async function dispatch<E>(
  listeners: Map<string, Listener<E>>,
  payload: Record<string, unknown>,
  what: string,
) {
  const failures: string[] = [];
  for (const [name, listener] of listeners) {
    try {
      await listener(payload as unknown as E);
    } catch (err) {
      logger.warn({ listener: name, err }, `${what} listener failed`);
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}

export const dispatchDeviceRevoked = (payload: Record<string, unknown>) =>
  dispatch(revokedListeners, payload, 'Device revoked');

export const dispatchDeviceSignedOut = (payload: Record<string, unknown>) =>
  dispatch(signedOutListeners, payload, 'Device signed out');
