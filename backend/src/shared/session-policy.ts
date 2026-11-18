import { INSTITUTE_IDLE_TIMEOUT_SETTING, isValidIdleTimeout } from '@erp/shared';
import { config } from '../infrastructure/config';
import { InstituteSetting } from '../modules/institutes/institute-setting.model';

/**
 * Inactivity logout (spec 4.18). A device's `lastSeenAt` is its last user activity: any
 * authenticated request except background polls (`X-Background-Request: 1`), plus the app's
 * heartbeat. Once it is older than the timeout, `authenticate` and `/auth/refresh` answer
 * 401 `SESSION_IDLE` until the user signs in again (password, OTP or biometric unlock).
 */

const TTL_MS = 60_000;
/** `lastSeenAt` is written at most this often per device. */
export const ACTIVITY_TOUCH_INTERVAL_MS = 60_000;
export const BACKGROUND_REQUEST_HEADER = 'x-background-request';

const cache = new Map<number, { minutes: number; expires: number }>();

/**
 * Minutes without activity before sessions of an institute lock (0 = never): the institute's
 * `security.idle_timeout_minutes` setting, else `SESSION_IDLE_TIMEOUT_MINUTES`. Sessions without
 * an institute (platform admin, institute not chosen yet) use the platform default. Cached briefly.
 */
export async function getIdleTimeoutMinutes(instituteId?: number | null): Promise<number> {
  const fallback = config.SESSION_IDLE_TIMEOUT_MINUTES;
  if (!instituteId) return fallback;
  const hit = cache.get(instituteId);
  if (hit && hit.expires > Date.now()) return hit.minutes;
  const row = await InstituteSetting.findOne({
    where: { instituteId, key: INSTITUTE_IDLE_TIMEOUT_SETTING },
  });
  const minutes = isValidIdleTimeout(row?.value) ? row.value : fallback;
  cache.set(instituteId, { minutes, expires: Date.now() + TTL_MS });
  return minutes;
}

/** Drop the cached timeout (call after saving the setting). */
export function clearIdleTimeoutCache(instituteId?: number) {
  if (instituteId == null) cache.clear();
  else cache.delete(instituteId);
}

/** True once a device has been inactive for longer than `minutes` (never when `minutes` is 0). */
export function isIdle(lastSeenAt: Date | null, minutes: number, now = Date.now()): boolean {
  return minutes > 0 && !!lastSeenAt && now - lastSeenAt.getTime() > minutes * 60_000;
}
