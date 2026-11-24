import { describe, expect, it } from 'vitest';
import { formatVariable, notifyAmount } from '../src/modules/notifications/format';
import { renderTemplate, templateParams } from '../src/modules/notifications/templates';

describe('notification formatting', () => {
  it('reads instants, days and times the Indian way, in the institute timezone', () => {
    const at = new Date('2026-11-27T15:30:00.000Z');
    expect(formatVariable(at, 'Asia/Kolkata')).toBe('27 Nov 2026, 9:00 pm');
    expect(formatVariable('2026-11-24T05:49:03.000Z', 'Asia/Kolkata')).toBe('24 Nov 2026, 11:19 am');
    expect(formatVariable(at, 'America/New_York')).toBe('27 Nov 2026, 10:30 am');
    expect(formatVariable(new Date('2026-01-01T18:30:00Z'), 'Asia/Kolkata')).toBe('2 Jan 2026, 12:00 am');
    expect(formatVariable('2026-11-16')).toBe('16 Nov 2026');
    expect(formatVariable('16:00')).toBe('4:00 pm');
    expect(formatVariable('00:05:00')).toBe('12:05 am');
  });

  it('leaves other values unchanged', () => {
    for (const v of ['R-1', '46,250', 'Mon, 16 Nov', '2026-11', '25:00', 'Riya'])
      expect(formatVariable(v)).toBe(v);
    expect(formatVariable(1500)).toBe('1500');
  });

  it('formats paise as rupees with Indian grouping and no needless .00', () => {
    expect(notifyAmount(4625000)).toBe('46,250');
    expect(notifyAmount(4625050)).toBe('46,250.50');
    expect(notifyAmount(12345600)).toBe('1,23,456');
    expect(notifyAmount(1234567800)).toBe('1,23,45,678');
    expect(notifyAmount(99)).toBe('0.99');
    expect(notifyAmount(-50000)).toBe('-500');
  });

  it('keeps vendor template variables short and ASCII-only (SMS, WhatsApp, DLT)', () => {
    const vars = {
      amount: notifyAmount(4625000),
      paidOn: '2026-11-16',
      startsAt: new Date('2026-11-27T15:30:00Z'),
    };
    const body = 'Received Rs {{amount}} on {{paidOn}}; class at {{startsAt}}';
    expect(renderTemplate(body, vars, 'Asia/Kolkata')).toBe(
      'Received Rs 46,250 on 16 Nov 2026; class at 27 Nov 2026, 9:00 pm',
    );
    const params = templateParams(body, vars, 'Asia/Kolkata').map((p) => p.value);
    expect(params).toEqual(['46,250', '16 Nov 2026', '27 Nov 2026, 9:00 pm']);
    for (const p of params) {
      expect(p).toMatch(/^[\x20-\x7e]*$/);
      expect(p.length).toBeLessThanOrEqual(30);
    }
  });
});
