import { describe, expect, it } from 'vitest';
import { REPORT_MAX_RANGE_DAYS } from '@erp/shared';
import { addDays, resolvePeriod } from './filters';

// 20:00 UTC on 17 Nov is already 18 Nov (a Wednesday) in India, but still 17 Nov in New York.
const now = new Date('2026-11-17T20:00:00Z');
const IST = 'Asia/Kolkata';

const range = (preset: Parameters<typeof resolvePeriod>[0]['preset'], at = now) => {
  const p = resolvePeriod({ preset }, IST, at);
  return [p.from, p.to];
};

describe('report periods', () => {
  it('resolves presets against today in the institute timezone', () => {
    expect(range('today')).toEqual(['2026-11-18', '2026-11-18']);
    expect(range('yesterday')).toEqual(['2026-11-17', '2026-11-17']);
    expect(range('last_7_days')).toEqual(['2026-11-12', '2026-11-18']);
    expect(range('this_week')).toEqual(['2026-11-16', '2026-11-18']);
    expect(range('last_week')).toEqual(['2026-11-09', '2026-11-15']);
    expect(range('this_month')).toEqual(['2026-11-01', '2026-11-18']);
    expect(range('last_month')).toEqual(['2026-10-01', '2026-10-31']);
    expect(range('this_quarter')).toEqual(['2026-10-01', '2026-11-18']);
    expect(range('last_quarter')).toEqual(['2026-07-01', '2026-09-30']);
    expect(range('this_fy')).toEqual(['2026-04-01', '2026-11-18']);
    expect(range('last_fy')).toEqual(['2025-04-01', '2026-03-31']);

    const january = new Date('2026-01-15T06:00:00Z');
    expect(range('last_month', january)).toEqual(['2025-12-01', '2025-12-31']);
    expect(range('last_quarter', january)).toEqual(['2025-10-01', '2025-12-31']);
    expect(range('this_fy', january)).toEqual(['2025-04-01', '2026-01-15']);
  });

  it('turns local dates into UTC instants for the timezone', () => {
    const ist = resolvePeriod({}, IST, now);
    expect(ist).toMatchObject({ preset: 'this_month', from: '2026-11-01', to: '2026-11-18', timezone: IST });
    expect(ist.start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(ist.end.toISOString()).toBe('2026-11-18T18:30:00.000Z');
    expect(ist.label).toBe('This month (1 Nov 2026 – 18 Nov 2026)');

    const ny = resolvePeriod({ preset: 'today' }, 'America/New_York', now);
    expect([ny.from, ny.start.toISOString(), ny.end.toISOString()]).toEqual([
      '2026-11-17',
      '2026-11-17T05:00:00.000Z',
      '2026-11-18T05:00:00.000Z',
    ]);
  });

  it('validates custom ranges', () => {
    const custom = resolvePeriod({ from: '2026-11-01', to: '2026-11-05' }, IST, now);
    expect(custom).toMatchObject({ preset: 'custom', from: '2026-11-01', to: '2026-11-05' });

    const bad = (input: Parameters<typeof resolvePeriod>[0]) => () => resolvePeriod(input, IST, now);
    expect(bad({ preset: 'custom', from: '2026-11-01' })).toThrow(/both from and to/);
    expect(bad({ from: '2026-02-30', to: '2026-03-01' })).toThrow(/valid/);
    expect(bad({ from: '2026-11-05', to: '2026-11-01' })).toThrow(/on or before/);
    expect(bad({ from: '2024-01-01', to: addDays('2024-01-01', REPORT_MAX_RANGE_DAYS) })).toThrow(/at most/);
    expect(() =>
      resolvePeriod({ from: '2024-01-01', to: addDays('2024-01-01', REPORT_MAX_RANGE_DAYS - 1) }, IST, now),
    ).not.toThrow();
  });
});
