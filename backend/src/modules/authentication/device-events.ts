import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';

export const DEVICE_REVOKED_JOB = 'authentication.device-revoked';

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

type Listener = (event: DeviceRevokedEvent) => Promise<void>;
const listeners = new Map<string, Listener>();

/**
 * Subscribe (from your module's `integrations.ts`) to device revocations, e.g. to revoke offline
 * licences or push tokens of that device. Devices are not tenant-scoped, so listeners run in a
 * background job without an institute context and act across institutes. They must be
 * idempotent: the job retries when any listener throws.
 */
export function onDeviceRevoked(name: string, listener: Listener): void {
  listeners.set(name, listener);
}

export async function emitDeviceRevoked(event: DeviceRevokedEvent): Promise<void> {
  if (!listeners.size) return;
  await enqueueJob(DEVICE_REVOKED_JOB, { ...event }, { instituteId: null });
}

export async function dispatchDeviceRevoked(payload: Record<string, unknown>): Promise<void> {
  const failures: string[] = [];
  for (const [name, listener] of listeners) {
    try {
      await listener(payload as unknown as DeviceRevokedEvent);
    } catch (err) {
      logger.warn({ listener: name, err }, 'Device revoked listener failed');
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
