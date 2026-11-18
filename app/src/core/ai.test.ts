import { describe, expect, it } from 'vitest';
import type { AiAvailabilityDto } from '@erp/shared';
import { aiAvailabilityNotice, formatUsd } from './ai';

const status = (o: Partial<AiAvailabilityDto> = {}): AiAvailabilityDto => ({
  available: true,
  reason: null,
  provider: 'openai',
  model: 'gpt-4o-mini',
  mock: false,
  tokensUsed: 1500,
  monthlyLimit: 100000,
  remainingTokens: 98500,
  ...o,
});

describe('aiAvailabilityNotice', () => {
  it('explains an exhausted quota with the tokens used', () => {
    const n = aiAvailabilityNotice(
      status({ available: false, reason: 'AI_QUOTA_EXCEEDED', tokensUsed: 100200, remainingTokens: 0 }),
    );
    expect(n.color).toBe('danger');
    expect(n.text).toContain('1,00,200 of 1,00,000 tokens');
  });

  it('flags simulated results from the mock provider', () => {
    const n = aiAvailabilityNotice(status({ provider: 'mock', model: 'mock-ai-1', mock: true }));
    expect(n.color).toBe('warning');
    expect(n.text).toMatch(/simulated/);
    expect(n.text).toContain('98,500 of 1,00,000 tokens left');
  });

  it('shows the real provider when no limit applies', () => {
    const n = aiAvailabilityNotice(status({ monthlyLimit: null, remainingTokens: null }));
    expect(n).toEqual({
      color: 'medium',
      text: 'AI grading uses openai · gpt-4o-mini. No monthly token limit.',
    });
  });
});

describe('formatUsd', () => {
  it('keeps fractions of a cent visible', () => {
    expect([formatUsd(0), formatUsd(0.00004), formatUsd(0.00123), formatUsd(12.5)]).toEqual([
      '$0.00',
      '< $0.0001',
      '$0.0012',
      '$12.50',
    ]);
  });
});
