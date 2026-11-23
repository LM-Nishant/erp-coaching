import { describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@erp/shared';
import { joinState, nextClass } from './format';

const now = Date.parse('2026-12-01T10:00:00Z');
const s = (id: number, status: LiveSessionDto['status'], start: string, end: string) =>
  ({ id, status, scheduledStartAt: start, scheduledEndAt: end }) as LiveSessionDto;

describe('nextClass', () => {
  it('prefers a live class, then the next scheduled one not yet over', () => {
    const stale = s(1, 'scheduled', '2026-12-01T08:00:00Z', '2026-12-01T09:00:00Z');
    const later = s(2, 'scheduled', '2026-12-01T12:00:00Z', '2026-12-01T13:00:00Z');
    const soon = s(3, 'scheduled', '2026-12-01T10:05:00Z', '2026-12-01T11:00:00Z');
    expect(nextClass([stale, later, soon], now)?.id).toBe(3);
    expect(nextClass([later, s(4, 'live', '2026-12-01T09:00:00Z', '2026-12-01T11:00:00Z')], now)?.id).toBe(4);
    expect(nextClass([stale], now)).toBeNull();
  });
});

describe('joinState', () => {
  it('counts down to the start and waits for the teacher after it', () => {
    expect(joinState(s(1, 'live', '', ''), now)).toEqual({ kind: 'live' });
    expect(joinState(s(1, 'scheduled', '2026-12-01T10:10:00Z', ''), now)).toEqual({
      kind: 'soon',
      minutes: 10,
    });
    expect(joinState(s(1, 'scheduled', '2026-12-01T11:00:00Z', ''), now)).toEqual({
      kind: 'later',
      minutes: 60,
    });
    expect(joinState(s(1, 'scheduled', '2026-12-01T09:59:00Z', ''), now)).toEqual({ kind: 'waiting' });
    expect(joinState(s(1, 'ended', '2026-12-01T09:00:00Z', ''), now)).toEqual({ kind: 'over' });
  });
});
