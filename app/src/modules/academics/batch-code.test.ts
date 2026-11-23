import { describe, expect, it } from 'vitest';
import { suggestBatchCode } from './batch-code';

describe('suggestBatchCode', () => {
  it('combines the course code with the start year and month', () => {
    expect(suggestBatchCode('jee-adv 2y', '2026-07-01', [])).toBe('JEEADV2Y-2607');
  });

  it('adds a letter when the code is taken', () => {
    expect(suggestBatchCode('NEET', '2026-04-15', ['neet-2604', 'NEET-2604B'])).toBe('NEET-2604C');
  });

  it('copes with a missing course code or date', () => {
    expect(suggestBatchCode('', '', [])).toBe('B');
  });
});
