import { describe, expect, it } from 'vitest';
import { clock, durationLabel, languageLabel, priceLabel } from './api';

describe('marketplace labels', () => {
  it('shows free and paid prices', () => {
    expect(priceLabel({ isFree: true, pricePaise: 0 })).toBe('Free');
    expect(priceLabel({ isFree: false, pricePaise: 49900 })).toBe('₹499');
    expect(priceLabel({ isFree: false, pricePaise: 129950 })).toBe('₹1,299.5');
  });

  it('formats course length and lecture times', () => {
    expect(durationLabel(0)).toBe('');
    expect(durationLabel(20)).toBe('20 s');
    expect(durationLabel(600)).toBe('10 min');
    expect(durationLabel(3600)).toBe('1 h');
    expect(durationLabel(5400)).toBe('1 h 30 min');
    expect(clock(75)).toBe('1:15');
  });

  it('names languages', () => {
    expect(languageLabel('en')).toBe('English');
    expect(languageLabel('xx')).toBe('XX');
  });
});
