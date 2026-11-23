import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatRelative,
  formatTime,
} from './format';

const TZ = { timeZone: 'Asia/Kolkata' };
const INSTANT = '2026-11-27T15:30:00Z'; // 9:00 pm in India

afterEach(() => setLocale('en'));

describe('format (en-IN)', () => {
  it('shows dates and times the Indian way', () => {
    expect(formatDate(INSTANT, TZ)).toBe('27 Nov 2026');
    expect(formatTime(INSTANT, TZ)).toBe('9:00 pm');
    expect(formatDateTime(INSTANT, TZ)).toBe('27 Nov 2026, 9:00 pm');
  });

  it('never shifts a calendar date', () => {
    expect(formatDate('2026-01-12', { timeZone: 'America/Los_Angeles' })).toBe('12 Jan 2026');
    expect(formatDate('2026-01-12', { timeZone: 'Pacific/Kiritimati' })).toBe('12 Jan 2026');
  });

  it('shows a dash for missing values and the raw text for unparseable ones', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatDate('soon')).toBe('soon');
  });

  it('shows paise as rupees with Indian grouping', () => {
    expect(formatMoney(4_125_000)).toBe('₹41,250');
    expect(formatMoney(4_125_050)).toBe('₹41,250.50');
    expect(formatMoney(1_25_00_000_00)).toBe('₹1,25,00,000');
    expect(formatMoneyCompact(66_000_000)).toBe('₹6.6L');
    expect(formatMoneyCompact(1_200_000_000)).toBe('₹1.2Cr');
    expect(formatMoneyCompact(3_840_049)).toBe('₹38,400');
  });

  it('says when something happens in words', () => {
    const now = '2026-11-27T15:00:00Z';
    expect(formatRelative('2026-11-27T15:25:00Z', now)).toBe('in 25 minutes');
    expect(formatRelative('2026-11-27T13:00:00Z', now)).toBe('2 hours ago');
    expect(formatRelative('2026-11-26T15:00:00Z', now)).toBe('yesterday');
    expect(formatRelative(now, now)).toBe('now');
  });

  it('formats durations and percentages', () => {
    expect(formatDuration(3_900)).toBe('1 h 5 min');
    expect(formatDuration(2_520)).toBe('42 min');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatPercent(92.4)).toBe('92%');
  });
});

describe('format (hi-IN)', () => {
  it('follows the chosen language', () => {
    setLocale('hi');
    expect(formatDate(INSTANT, TZ)).toBe('27 नव॰ 2026');
    expect(formatMoney(4_125_000)).toBe('₹41,250');
    expect(formatRelative('2026-11-27T15:25:00Z', '2026-11-27T15:00:00Z')).toBe('25 मिनट में');
  });
});
