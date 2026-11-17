/** Default institute timezone (IANA) used until an institute saves its own. */
export const DEFAULT_INSTITUTE_TIMEZONE = 'Asia/Kolkata';

/** Institute setting key holding the IANA timezone string. */
export const INSTITUTE_TIMEZONE_SETTING = 'timezone';

/**
 * `GET /institute/settings`: every saved key/value plus the effective `timezone`.
 * All institute wall-clock values (class times, appointment slots, "today") are interpreted in it.
 */
export interface InstituteSettingsDto {
  timezone: string;
  [key: string]: unknown;
}

/** True when `tz` is an IANA timezone the runtime's Intl understands (e.g. `Asia/Kolkata`). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
