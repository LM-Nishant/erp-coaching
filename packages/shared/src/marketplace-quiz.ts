/**
 * Marketplace quizzes (a `quiz` lecture) and course completion certificates.
 * Quiz answers are graded on the server; learners only see the correct answers after submitting.
 */

/** `single`: exactly one correct option; `multi`: one or more correct options (all must be chosen). */
export const MKT_QUIZ_QUESTION_KINDS = ['single', 'multi'] as const;
export type MktQuizQuestionKind = (typeof MKT_QUIZ_QUESTION_KINDS)[number];

export const MKT_QUIZ_MAX_QUESTIONS = 100;
export const MKT_QUIZ_MAX_OPTIONS = 8;
export const MKT_QUIZ_DEFAULT_PASS_PERCENT = 70;

export interface MktQuizOptionDto {
  /** Stable key within the question, e.g. `A`. */
  key: string;
  text: string;
}

/** A question as the seller edits it (with the answer key). */
export interface MktQuizQuestionDto {
  id: number;
  kind: MktQuizQuestionKind;
  prompt: string;
  options: MktQuizOptionDto[];
  correct: string[];
  explanation: string | null;
}

export interface MktQuizDto {
  lectureId: number;
  /** Minimum score (percent) that passes the quiz and completes the lecture. */
  passPercent: number;
  /** null = unlimited attempts. */
  maxAttempts: number | null;
  shuffle: boolean;
  questions: MktQuizQuestionDto[];
}

export interface MktQuizQuestionInput {
  kind: MktQuizQuestionKind;
  prompt: string;
  options: MktQuizOptionDto[];
  correct: string[];
  explanation?: string | null;
}

/** Replaces the quiz settings and its questions (in order). */
export interface MktQuizInput {
  passPercent: number;
  maxAttempts?: number | null;
  shuffle?: boolean;
  questions: MktQuizQuestionInput[];
}

/** Copies single/multiple-correct and true/false questions from the institute's question bank. */
export interface MktQuizImportInput {
  questionIds: number[];
}

/** A question as the learner sees it before answering (no answer key). */
export interface MktQuizLearnerQuestionDto {
  id: number;
  kind: MktQuizQuestionKind;
  prompt: string;
  options: MktQuizOptionDto[];
}

export interface MktQuizAttemptSummaryDto {
  id: number;
  score: number;
  total: number;
  percent: number;
  passed: boolean;
  createdAt: string;
}

export interface MktQuizLearnerDto {
  lectureId: number;
  passPercent: number;
  maxAttempts: number | null;
  attemptsUsed: number;
  /** Whether another attempt may be submitted. */
  canAttempt: boolean;
  passed: boolean;
  bestPercent: number | null;
  questions: MktQuizLearnerQuestionDto[];
  attempts: MktQuizAttemptSummaryDto[];
}

/** Answers keyed by question id: the chosen option keys. */
export interface MktQuizAttemptInput {
  answers: Record<string, string[]>;
}

export interface MktQuizResultQuestionDto extends MktQuizQuestionDto {
  chosen: string[];
  isCorrect: boolean;
}

export interface MktQuizResultDto extends MktQuizAttemptSummaryDto {
  passPercent: number;
  questions: MktQuizResultQuestionDto[];
  /** Course progress after the attempt (a passing attempt completes the lecture). */
  progressPercent: number;
  /** Issued when this attempt completed the course. */
  certificateCode: string | null;
}

// ---------------------------------------------------------------- certificates

export interface MktCertificateDto {
  code: string;
  learnerName: string;
  courseTitle: string;
  courseSlug: string | null;
  courseId: number;
  sellerName: string;
  issuedAt: string;
  /** Public page that confirms the certificate. */
  verifyPath: string;
}

export interface MktCertificateVerifyDto {
  valid: true;
  certificate: MktCertificateDto;
}

/** Certificate codes: `MKT-` and 10 upper-case letters/digits (no ambiguous 0/O/1/I). */
export const MKT_CERTIFICATE_CODE_PATTERN = /^MKT-[A-HJ-NP-Z2-9]{10}$/;

export const mktCertificateVerifyPath = (code: string) => `/market/certificates/${code}`;

/** Grades one question: every correct option and no other must be chosen. */
export function mktQuizIsCorrect(correct: readonly string[], chosen: readonly string[]): boolean {
  const c = new Set(correct);
  const s = new Set(chosen);
  return c.size > 0 && c.size === s.size && [...c].every((k) => s.has(k));
}
