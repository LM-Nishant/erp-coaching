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

/** Steps of the new-institute setup checklist, in the order staff should do them. */
export const SETUP_STEPS = [
  'profile',
  'course',
  'batch',
  'feeStructure',
  'teacher',
  'student',
  'paymentGateway',
  'parents',
] as const;
export type SetupStepKey = (typeof SETUP_STEPS)[number];

export interface SetupStepDto {
  key: SetupStepKey;
  done: boolean;
  /** How many records exist for the step (e.g. batches), for "3 added" hints. */
  count: number;
}

/**
 * `GET /institute/setup-status`: the steps that apply to the institute's plan, with done flags.
 * `complete` is true once every listed step is done, so the app can hide the checklist.
 */
export interface SetupStatusDto {
  steps: SetupStepDto[];
  done: number;
  total: number;
  complete: boolean;
}
