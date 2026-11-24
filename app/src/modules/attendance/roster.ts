import type { AttendanceMethod, AttendanceStatus, RosterEntryDto } from '@erp/shared';

/**
 * Roll-call rules of the roster page (teacher apps' "everyone present, tap the absentees"):
 * - With manual marking only, a student nobody has marked yet counts as present (on approved leave: leave)
 *   until the teacher taps them; submitting saves those defaults.
 * - When students also check themselves in (mobile, QR, biometric), an unmarked student hasn't arrived,
 *   so they stay "Not marked" and closing marks them absent as before.
 */
export type Pending = Record<number, AttendanceStatus>;

/** What an unmarked student starts as: `present` for manual roll call, `null` (not marked) with self check-in. */
export function startStatus(methods: readonly AttendanceMethod[] | undefined): 'present' | null {
  return !methods || methods.every((m) => m === 'manual') ? 'present' : null;
}

/** The status shown for a row: the teacher's unsaved tap, the saved mark, or the start status. */
export function shownStatus(
  r: RosterEntryDto,
  pending: Pending,
  start: 'present' | null,
): AttendanceStatus | null {
  return pending[r.studentUserId] ?? r.status ?? (start && r.onLeave ? 'leave' : start);
}

/** A tap marks a present student absent and anyone else (absent, late, on leave, not marked) present. */
export function tapped(current: AttendanceStatus | null): AttendanceStatus {
  return current === 'present' ? 'absent' : 'present';
}

/** Sets `status` for a row in `pending`, dropping the entry when it matches the saved mark. */
export function setPending(pending: Pending, r: RosterEntryDto, status: AttendanceStatus): Pending {
  const next = { ...pending };
  if (r.status === status) delete next[r.studentUserId];
  else next[r.studentUserId] = status;
  return next;
}

/** Marks to send: every shown status that differs from what is saved (start defaults included). */
export function changes(
  roster: readonly RosterEntryDto[],
  pending: Pending,
  start: 'present' | null,
): { studentUserId: number; status: AttendanceStatus }[] {
  const out: { studentUserId: number; status: AttendanceStatus }[] = [];
  for (const r of roster) {
    const s = shownStatus(r, pending, start);
    if (s && s !== r.status) out.push({ studentUserId: r.studentUserId, status: s });
  }
  return out;
}

export type Tally = Record<AttendanceStatus | 'unmarked', number>;

export function tally(roster: readonly RosterEntryDto[], pending: Pending, start: 'present' | null): Tally {
  const t: Tally = { present: 0, absent: 0, late: 0, leave: 0, half_day: 0, unmarked: 0 };
  for (const r of roster) t[shownStatus(r, pending, start) ?? 'unmarked']++;
  return t;
}

/** A wall-clock `HH:MM[:SS]` (class start/end times) in the user's format, e.g. `10:00 am`. */
export function clock(hhmm: string | null | undefined, format: (d: Date) => string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  return m ? format(new Date(2000, 0, 1, +m[1], +m[2])) : '';
}
