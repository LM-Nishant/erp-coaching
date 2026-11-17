import { describe, expect, it } from 'vitest';
import { isValidTimeZone, nowInZone, todayIn, zonedDateTimeToUtc } from './timezone';

describe('timezone helpers', () => {
  it('converts institute wall-clock times to instants', () => {
    expect(zonedDateTimeToUtc('2026-11-17', '09:30', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-17T04:00:00.000Z',
    );
    expect(zonedDateTimeToUtc('2026-11-17', '00:15', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-16T18:45:00.000Z',
    );
    expect(zonedDateTimeToUtc('2026-11-17', '09:30', 'UTC').toISOString()).toBe('2026-11-17T09:30:00.000Z');
    // DST: summer/winter offsets, and a skipped time resolves forward.
    expect(zonedDateTimeToUtc('2026-07-01', '12:00', 'America/New_York').toISOString()).toBe(
      '2026-07-01T16:00:00.000Z',
    );
    expect(zonedDateTimeToUtc('2026-12-01', '12:00', 'America/New_York').toISOString()).toBe(
      '2026-12-01T17:00:00.000Z',
    );
    expect(zonedDateTimeToUtc('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('reads the wall clock and today in a zone', () => {
    // 20:00 UTC is already the next day in India.
    const at = new Date('2026-11-17T20:00:00Z');
    expect(todayIn('UTC', at)).toBe('2026-11-17');
    expect(todayIn('Asia/Kolkata', at)).toBe('2026-11-18');
    expect(nowInZone('Asia/Kolkata', at)).toEqual({ date: '2026-11-18', time: '01:30', minutes: 90 });
    expect(nowInZone('Asia/Kolkata', new Date('2026-11-17T18:30:00Z')).time).toBe('00:00');
  });

  it('validates IANA names', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
