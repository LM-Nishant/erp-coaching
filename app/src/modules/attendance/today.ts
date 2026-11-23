import type { AttendanceDayItemDto, LiveSessionDto } from '@erp/shared';

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (t: string | null) => (t ?? '').slice(0, 5);

/**
 * The class to put first on a teacher's Today home: the one happening now, else the next one today, else
 * the latest one whose attendance is still not submitted. `now` is the wall clock as `HH:MM`.
 */
export function focusClass(
  items: readonly AttendanceDayItemDto[],
  now: string,
): { item: AttendanceDayItemDto; when: 'now' | 'next' | 'earlier' } | null {
  const timed = items.filter((i) => i.startTime);
  const current = timed.find((i) => hm(i.startTime) <= now && (!i.endTime || now < hm(i.endTime)));
  if (current) return { item: current, when: 'now' };
  const next = timed
    .filter((i) => hm(i.startTime) > now)
    .sort((a, b) => hm(a.startTime).localeCompare(hm(b.startTime)))[0];
  if (next) return { item: next, when: 'next' };
  const pending = [...items].reverse().find((i) => i.attendance?.status !== 'closed');
  return pending ? { item: pending, when: 'earlier' } : null;
}

/** The live class held for a timetable class: linked by class session, else same batch starting the same day. */
export function liveFor(
  item: AttendanceDayItemDto,
  live: readonly LiveSessionDto[],
  date: string,
): LiveSessionDto | null {
  return (
    live.find((l) => item.classSessionId && l.classSessionId === item.classSessionId) ??
    live.find(
      (l) => !l.classSessionId && l.batchId === item.batchId && ymd(new Date(l.scheduledStartAt)) === date,
    ) ??
    null
  );
}
