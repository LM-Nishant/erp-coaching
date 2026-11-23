import { describe, expect, it } from 'vitest';
import type { RosterEntryDto } from '@erp/shared';
import { changes, clock, setPending, shownStatus, startStatus, tally, tapped } from './roster';

const row = (id: number, extra: Partial<RosterEntryDto> = {}): RosterEntryDto => ({
  studentUserId: id,
  name: `S${id}`,
  status: null,
  source: null,
  markedAt: null,
  remarks: null,
  onLeave: false,
  ...extra,
});

describe('roll call', () => {
  it('starts everyone present only for manual-only marking', () => {
    expect(startStatus(['manual'])).toBe('present');
    expect(startStatus(undefined)).toBe('present');
    expect(startStatus(['manual', 'qr'])).toBeNull();
  });

  it('shows a pending tap, then the saved mark, then leave or the start status', () => {
    expect(shownStatus(row(1, { status: 'late' }), { 1: 'absent' }, 'present')).toBe('absent');
    expect(shownStatus(row(1, { status: 'late' }), {}, 'present')).toBe('late');
    expect(shownStatus(row(1, { onLeave: true }), {}, 'present')).toBe('leave');
    expect(shownStatus(row(1, { onLeave: true }), {}, null)).toBeNull();
  });

  it('toggles present and absent, and makes anyone else present', () => {
    expect(tapped('present')).toBe('absent');
    expect(tapped('absent')).toBe('present');
    expect(tapped('leave')).toBe('present');
    expect(tapped(null)).toBe('present');
  });

  it('drops a pending mark that equals the saved one', () => {
    const r = row(1, { status: 'absent' });
    expect(setPending({ 1: 'present' }, r, 'absent')).toEqual({});
    expect(setPending({}, r, 'present')).toEqual({ 1: 'present' });
  });

  it('sends start defaults with the taps, but not what is already saved', () => {
    const roster = [row(1), row(2), row(3, { status: 'present' }), row(4, { onLeave: true })];
    expect(changes(roster, { 2: 'absent' }, 'present')).toEqual([
      { studentUserId: 1, status: 'present' },
      { studentUserId: 2, status: 'absent' },
      { studentUserId: 4, status: 'leave' },
    ]);
    expect(changes(roster, { 2: 'absent' }, null)).toEqual([{ studentUserId: 2, status: 'absent' }]);
  });

  it('counts not-marked students with self check-in', () => {
    const roster = [row(1), row(2, { status: 'present' }), row(3)];
    expect(tally(roster, { 3: 'absent' }, null)).toMatchObject({ present: 1, absent: 1, unmarked: 1 });
    expect(tally(roster, {}, 'present')).toMatchObject({ present: 3, unmarked: 0 });
  });

  it('formats wall-clock times and ignores blanks', () => {
    expect(clock('14:05:00', (d) => `${d.getHours()}h${d.getMinutes()}`)).toBe('14h5');
    expect(clock(null, () => 'x')).toBe('');
  });
});
