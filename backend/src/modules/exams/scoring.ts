import crypto from 'node:crypto';
import type { AnswerResponse } from '@erp/shared';
import type { QuestionSnapshot } from './models';

export interface ScoringRule {
  marks: number;
  negativeMarks: number;
  partialMarking: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function isAnswered(snapshot: Pick<QuestionSnapshot, 'type'>, r: AnswerResponse | null | undefined): boolean {
  if (!r) return false;
  switch (snapshot.type) {
    case 'single':
    case 'multiple':
      return !!r.options?.length;
    case 'numerical':
      return typeof r.value === 'number' && Number.isFinite(r.value);
    case 'true_false':
      return typeof r.value === 'boolean';
    case 'descriptive':
      return !!r.text?.trim();
  }
}

/**
 * Scores an objective answer. Returns null for descriptive questions (evaluated separately).
 * - single / true_false: +marks when correct, −negative when wrong, 0 when unanswered
 * - multiple: any wrong option → −negative; otherwise partial marking gives marks × (selected ÷ correct),
 *   without partial marking only the exact set scores
 * - numerical: value ± tolerance, or within the inclusive min..max range
 */
export function scoreObjective(
  snapshot: QuestionSnapshot,
  rule: ScoringRule,
  response: AnswerResponse | null | undefined,
): { score: number; isCorrect: boolean | null } | null {
  if (snapshot.type === 'descriptive') return null;
  if (!isAnswered(snapshot, response)) return { score: 0, isCorrect: null };
  const key = snapshot.answerKey;
  const wrong = { score: round2(-Math.abs(rule.negativeMarks)), isCorrect: false };
  const right = { score: round2(rule.marks), isCorrect: true };
  switch (snapshot.type) {
    case 'single':
      return response!.options!.length === 1 && key.options?.[0] === response!.options![0].toUpperCase()
        ? right
        : wrong;
    case 'true_false':
      return response!.value === key.value ? right : wrong;
    case 'numerical': {
      const v = response!.value as number;
      const ok =
        typeof key.value === 'number'
          ? Math.abs(v - key.value) <= (key.tolerance ?? 0) + 1e-9
          : typeof key.min === 'number' && typeof key.max === 'number' && v >= key.min - 1e-9 && v <= key.max + 1e-9;
      return ok ? right : wrong;
    }
    case 'multiple': {
      const correct = new Set((key.options ?? []).map((k) => k.toUpperCase()));
      const chosen = new Set(response!.options!.map((k) => k.toUpperCase()));
      if ([...chosen].some((k) => !correct.has(k))) return wrong;
      if (chosen.size === correct.size) return right;
      if (!rule.partialMarking) return { score: 0, isCorrect: false };
      return { score: round2((rule.marks * chosen.size) / correct.size), isCorrect: false };
    }
  }
}

/** Fisher–Yates with a crypto RNG. */
export function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Competition ranking (1, 2, 2, 4) and percentile = % of candidates scoring ≤ the candidate. */
export function rankScores<T extends { id: number; score: number }>(rows: T[]) {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const n = sorted.length;
  const out = new Map<number, { rank: number; percentile: number }>();
  sorted.forEach((r, idx) => {
    const rank = idx > 0 && sorted[idx - 1].score === r.score ? out.get(sorted[idx - 1].id)!.rank : idx + 1;
    const atOrBelow = sorted.filter((s) => s.score <= r.score).length;
    out.set(r.id, { rank, percentile: round2((atOrBelow / n) * 100) });
  });
  return out;
}

export { round2 };
