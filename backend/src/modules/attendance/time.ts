import { nowInZone, zonedDateTimeToUtc } from '../../shared/timezone';

/** Date/time helpers. Class dates and times are institute-local wall-clock values in `tz`. */

export const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in the institute timezone. */
export function localDate(tz: string, now = new Date()): string {
  return nowInZone(tz, now).date;
}

/** Wall-clock `HH:MM` of `d` in the institute timezone. */
export const localHhmm = (d: Date, tz: string) => nowInZone(tz, d).time;

export const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes between the class start (`date` + `hhmm`, institute-local) and `now`; negative before start. */
export function minutesSinceStart(date: string, hhmm: string, tz: string, now = new Date()): number {
  return (now.getTime() - zonedDateTimeToUtc(date, hhmm.slice(0, 5), tz).getTime()) / 60000;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export function monthBounds(year: number, month: number) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(days).padStart(2, '0')}` };
}

/** Great-circle distance in metres. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
