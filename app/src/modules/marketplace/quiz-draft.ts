import type { MktQuizOptionDto, MktQuizQuestionKind } from '@erp/shared';

/** A question while the seller edits it. */
export interface QuizDraftQuestion {
  uid: number;
  kind: MktQuizQuestionKind;
  prompt: string;
  options: MktQuizOptionDto[];
  correct: string[];
  explanation: string;
}

/** First problem that stops the quiz from being saved, or null when it is valid. */
export function quizProblem(questions: QuizDraftQuestion[], passPercent: number): string | null {
  if (!Number.isInteger(passPercent) || passPercent < 1 || passPercent > 100)
    return 'The pass mark must be between 1 and 100%.';
  for (const [i, q] of questions.entries()) {
    const n = `Question ${i + 1}`;
    if (!q.prompt.trim()) return `${n} needs its question text.`;
    if (q.options.some((o) => !o.text.trim())) return `${n} has an empty option.`;
    if (!q.correct.length) return `${n} needs a correct answer.`;
    if (q.kind === 'single' && q.correct.length > 1) return `${n} can only have one correct answer.`;
  }
  return null;
}
