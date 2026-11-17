import { DEFAULT_INSTITUTE_TIMEZONE, INSTITUTE_TIMEZONE_SETTING, isValidTimeZone } from '@erp/shared';
import { InstituteSetting } from '../modules/institutes/institute-setting.model';
import { requireTenantContext } from './context';

/**
 * Institute timezone helpers. Dates (`YYYY-MM-DD`) and times (`HH:mm`) stored by modules are
 * institute wall-clock values; convert them to instants with these helpers (never server-local time).
 */

export { DEFAULT_INSTITUTE_TIMEZONE, isValidTimeZone };

const TTL_MS = 60_000;
const cache = new Map<number, { tz: string; expires: number }>();

/** Effective IANA timezone of an institute (defaults to the current tenant). Cached briefly. */
export async function getInstituteTimezone(instituteId?: number): Promise<string> {
  const id = instituteId ?? requireTenantContext().instituteId;
  const hit = cache.get(id);
  if (hit && hit.expires > Date.now()) return hit.tz;
  const row = await InstituteSetting.findOne({ where: { instituteId: id, key: INSTITUTE_TIMEZONE_SETTING } });
  const tz = isValidTimeZone(row?.value) ? row.value : DEFAULT_INSTITUTE_TIMEZONE;
  cache.set(id, { tz, expires: Date.now() + TTL_MS });
  return tz;
}

/** Drop the cached timezone (call after saving the setting). */
export function clearInstituteTimezoneCache(instituteId?: number) {
  if (instituteId == null) cache.clear();
  else cache.delete(instituteId);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(tz: string, at: Date) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset (ms) of `tz` from UTC at instant `at` (positive east of Greenwich). */
function offsetMs(tz: string, at: Date): number {
  const p = partsIn(tz, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads `date` `time` (`HH:mm` or `HH:mm:ss`).
 * Times skipped by a DST jump resolve forward.
 */
export function zonedDateTimeToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s = 0] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = offsetMs(tz, new Date(wall));
  const o2 = offsetMs(tz, new Date(wall - o1));
  if (o1 === o2) return new Date(wall - o1);
  if (offsetMs(tz, new Date(wall - o2)) === o2) return new Date(wall - o2);
  return new Date(wall - Math.min(o1, o2));
}

/** Wall-clock date/time in `tz` at `now`. */
export function nowInZone(tz: string, now = new Date()): { date: string; time: string; minutes: number } {
  const p = partsIn(tz, now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    minutes: p.hour * 60 + p.minute,
  };
}

/** Today's `YYYY-MM-DD` in `tz`. */
export const todayIn = (tz: string, now = new Date()) => nowInZone(tz, now).date;

/** Today's date in the current institute's timezone. */
export async function instituteToday(instituteId?: number): Promise<string> {
  return todayIn(await getInstituteTimezone(instituteId));
}
