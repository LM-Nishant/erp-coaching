import { DEFAULT_INSTITUTE_TIMEZONE } from '@erp/shared';

/**
 * How notification variables read in messages, in Indian style: `27 Nov 2026, 9:00 pm`, `₹46,250`.
 * Output is plain ASCII (no narrow no-break spaces from Intl) so SMS stays GSM-7 per variable and
 * fills DLT `{#var#}` slots (≤ 30 chars) and WhatsApp template variables unchanged.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})(?::\d{2})?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const day = (y: number, m: number, d: number) => `${d} ${MONTHS[m - 1]} ${y}`;
const clock = (h: number, min: number) =>
  `${h % 12 || 12}:${String(min).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(at: Date, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, min: p.minute };
}

/** `2026-11-27T15:30:00Z` → `27 Nov 2026, 9:00 pm` in the institute's timezone. */
export function formatInstant(at: Date, timeZone = DEFAULT_INSTITUTE_TIMEZONE): string {
  const p = partsIn(at, timeZone);
  return `${day(p.y, p.m, p.d)}, ${clock(p.h, p.min)}`;
}

/**
 * A template variable as people read it: instants (Date or ISO string) in `timeZone`, wall-clock days
 * (`YYYY-MM-DD` → `16 Nov 2026`) and times (`16:00` → `4:00 pm`) as is. Anything else is unchanged.
 */
export function formatVariable(value: unknown, timeZone?: string): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : formatInstant(value, timeZone);
  const s = String(value);
  const d = DAY.exec(s);
  if (d) return day(Number(d[1]), Number(d[2]), Number(d[3]));
  const t = TIME.exec(s);
  if (t && Number(t[1]) < 24) return clock(Number(t[1]), Number(t[2]));
  if (INSTANT.test(s)) {
    const at = new Date(s);
    if (!Number.isNaN(at.getTime())) return formatInstant(at, timeZone);
  }
  return s;
}

/** 4625000 paise → `46,250`; 4625050 → `46,250.50` (Indian grouping). Put `₹` in the template. */
export function notifyAmount(paise: number): string {
  const abs = Math.abs(Math.round(paise));
  const rupees = String(Math.floor(abs / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const fraction = abs % 100 ? `.${String(abs % 100).padStart(2, '0')}` : '';
  return `${paise < 0 ? '-' : ''}${rest ? `${rest},` : ''}${last3}${fraction}`;
}
