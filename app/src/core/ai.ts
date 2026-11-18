import type { AiAvailabilityDto } from '@erp/shared';

export const formatTokens = (n: number | null | undefined) => Number(n ?? 0).toLocaleString('en-IN');

/** Estimated AI cost in USD; single calls usually cost fractions of a cent. */
export function formatUsd(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!v) return '$0.00';
  if (v < 0.0001) return '< $0.0001';
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

export interface AiNotice {
  color: 'danger' | 'warning' | 'medium';
  text: string;
}

/** Banner text for AI-graded screens: why AI can't run, or which provider runs and the quota left. */
export function aiAvailabilityNotice(s: AiAvailabilityDto): AiNotice {
  switch (s.reason) {
    case 'MODULE_DISABLED':
      return { color: 'danger', text: 'AI is not included in your plan. Grade these answers manually.' };
    case 'SUBSCRIPTION_INACTIVE':
      return { color: 'danger', text: 'Your subscription is inactive, so AI grading is unavailable.' };
    case 'AI_NOT_CONFIGURED':
      return {
        color: 'danger',
        text: 'No AI provider is configured on the platform, so AI grading is unavailable. Grade manually.',
      };
    case 'AI_QUOTA_EXCEEDED':
      return {
        color: 'danger',
        text: `This month's AI quota is used up (${formatTokens(s.tokensUsed)} of ${formatTokens(s.monthlyLimit)} tokens). Grade manually until it resets next month.`,
      };
  }
  const quota =
    s.remainingTokens === null
      ? 'No monthly token limit.'
      : `${formatTokens(s.remainingTokens)} of ${formatTokens(s.monthlyLimit)} tokens left this month.`;
  if (s.mock) {
    return {
      color: 'warning',
      text: `Offline mock AI (${s.model}): suggestions are simulated for testing. ${quota}`,
    };
  }
  return { color: 'medium', text: `AI grading uses ${s.provider} · ${s.model}. ${quota}` };
}
