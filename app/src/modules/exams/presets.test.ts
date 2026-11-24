import { describe, expect, it } from 'vitest';
import { closesAfter, defaultOpens, EXAM_PATTERNS, patternOf, toLocalInput } from './presets';

describe('exam presets', () => {
  it('recognises a preset scheme, anything else is custom', () => {
    const neet = EXAM_PATTERNS.find((p) => p.id === 'neet')!;
    expect(patternOf(neet)).toBe('neet');
    expect(patternOf({ ...neet, durationMinutes: 90 })).toBe('custom');
  });

  it('opens tomorrow at 10 and closes after the duration', () => {
    const opens = defaultOpens(new Date(2026, 10, 30, 18, 45));
    expect(toLocalInput(opens)).toBe('2026-12-01T10:00');
    expect(closesAfter('2026-12-01T10:00', 200)).toBe('2026-12-01T13:20');
  });
});
