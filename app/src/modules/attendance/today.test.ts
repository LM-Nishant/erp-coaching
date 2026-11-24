import { describe, expect, it } from 'vitest';
import type { AttendanceDayItemDto, LiveSessionDto } from '@erp/shared';
import { daySummary, focusClass, liveFor } from './today';

const item = (id: number, startTime: string, endTime: string, closed = false): AttendanceDayItemDto =>
  ({
    classSessionId: id,
    batchId: 100 + id,
    batchName: `B${id}`,
    subjectName: 'Physics',
    startTime,
    endTime,
    attendance: closed ? { id, status: 'closed', counts: {} } : null,
  }) as AttendanceDayItemDto;

describe('focusClass', () => {
  const day = [item(1, '10:00:00', '11:30:00', true), item(2, '14:00:00', '15:30:00')];

  it('picks the class happening now, else the next one', () => {
    expect(focusClass(day, '10:15')).toMatchObject({ item: { classSessionId: 1 }, when: 'now' });
    expect(focusClass(day, '12:00')).toMatchObject({ item: { classSessionId: 2 }, when: 'next' });
  });

  it('after the last class, points at attendance still to submit', () => {
    expect(focusClass(day, '18:00')).toMatchObject({ item: { classSessionId: 2 }, when: 'earlier' });
    expect(focusClass([day[0]], '18:00')).toBeNull();
  });
});

describe('liveFor', () => {
  const live = (over: Partial<LiveSessionDto>) =>
    ({ id: 9, classSessionId: null, batchId: 0, ...over }) as LiveSessionDto;

  it('matches by class session, else by batch on the same day', () => {
    const it2 = item(2, '14:00', '15:30');
    expect(liveFor(it2, [live({ classSessionId: 2 })], '2026-11-23')?.id).toBe(9);
    const sameDay = live({ batchId: 102, scheduledStartAt: new Date(2026, 10, 23, 14).toISOString() });
    expect(liveFor(it2, [sameDay], '2026-11-23')).toBe(sameDay);
    expect(liveFor(it2, [sameDay], '2026-11-24')).toBeNull();
  });
});

describe('daySummary', () => {
  it('counts submitted and pending classes and adds up absentees', () => {
    const a = { ...item(1, '09:00', '10:00', true) };
    a.attendance = { id: 1, status: 'closed', counts: { present: 20, absent: 3 } };
    const b = { ...item(2, '11:00', '12:00') };
    b.attendance = { id: 2, status: 'open', counts: { absent: 1 } };
    const c = { ...item(3, '14:00', '15:00') };
    c.attendance = null;
    expect(daySummary([a, b, c])).toEqual({ classes: 3, submitted: 1, pending: 2, absent: 4 });
    expect(daySummary([])).toEqual({ classes: 0, submitted: 0, pending: 0, absent: 0 });
  });
});
