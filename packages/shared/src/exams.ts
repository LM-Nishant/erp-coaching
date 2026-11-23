/** Question bank, examinations and AI grading (spec §4.10, §4.11). */

// ---------------------------------------------------------------- question bank

export const QUESTION_TYPES = ['single', 'multiple', 'numerical', 'true_false', 'descriptive'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  single: 'Single-correct MCQ',
  multiple: 'Multiple-correct MCQ',
  numerical: 'Numerical',
  true_false: 'True / false',
  descriptive: 'Descriptive',
};

export const QUESTION_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

export const QUESTION_STATUSES = ['draft', 'active', 'archived'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export type QuestionSource = 'manual' | 'import' | 'ai';

/** `private`: only the owner (and bank managers) can see/reuse; `shared`: every staff member with view. */
export const BANK_VISIBILITIES = ['private', 'shared'] as const;
export type BankVisibility = (typeof BANK_VISIBILITIES)[number];

export interface QuestionOption {
  /** Stable key, e.g. `A`. */
  key: string;
  text: string;
  imageFileId?: number | null;
  imageUrl?: string | null;
}

/**
 * Answer key per type:
 * - single / multiple: `options` (keys of the correct options; exactly one for single)
 * - true_false: `value`
 * - numerical: `value` ± `tolerance`, or an inclusive `min`..`max` range
 * - descriptive: optional `modelAnswer` and `rubric` used by evaluators and AI grading
 */
export interface AnswerKey {
  options?: string[];
  value?: number | boolean;
  tolerance?: number;
  min?: number;
  max?: number;
  modelAnswer?: string;
  rubric?: string;
}

export interface QuestionBankDto {
  id: number;
  branchId: number | null;
  name: string;
  description: string | null;
  subjectId: number | null;
  subjectName?: string | null;
  visibility: BankVisibility;
  ownerUserId: number | null;
  ownerName?: string | null;
  questionCount?: number;
  canEdit: boolean;
  createdAt: string;
}

export interface QuestionBankInput {
  name: string;
  description?: string | null;
  subjectId?: number | null;
  visibility?: BankVisibility;
  branchId?: number | null;
}

export interface QuestionAssetDto {
  id: number;
  fileId: number;
  role: 'question' | 'explanation';
  url: string;
  originalName: string;
}

export interface QuestionDto {
  id: number;
  bankId: number;
  type: QuestionType;
  text: string;
  options: QuestionOption[];
  answerKey: AnswerKey;
  explanation: string | null;
  difficulty: QuestionDifficulty;
  tags: string[];
  subjectId: number | null;
  chapterId: number | null;
  topicId: number | null;
  chapterName?: string | null;
  topicName?: string | null;
  defaultMarks: number;
  defaultNegativeMarks: number;
  status: QuestionStatus;
  source: QuestionSource;
  assets: QuestionAssetDto[];
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionInput {
  type: QuestionType;
  text: string;
  options?: { key: string; text: string; imageFileId?: number | null }[];
  answerKey: AnswerKey;
  explanation?: string | null;
  difficulty?: QuestionDifficulty;
  tags?: string[];
  subjectId?: number | null;
  chapterId?: number | null;
  topicId?: number | null;
  defaultMarks?: number;
  defaultNegativeMarks?: number;
  status?: QuestionStatus;
  source?: QuestionSource;
}

export interface QuestionImportResult {
  created: number;
  failed: { row: number; message: string }[];
}

/** Columns of the CSV/Excel bulk import template, in order. */
export const QUESTION_IMPORT_COLUMNS = [
  'type',
  'text',
  'option_a',
  'option_b',
  'option_c',
  'option_d',
  'option_e',
  'option_f',
  'answer',
  'tolerance',
  'explanation',
  'difficulty',
  'tags',
  'marks',
  'negative_marks',
  'chapter',
  'topic',
] as const;

export interface GenerateQuestionsInput {
  topicId?: number | null;
  /** Free-text topic when no academics topic is chosen. */
  topic?: string;
  type: QuestionType;
  count: number;
  difficulty?: QuestionDifficulty;
  instructions?: string;
}

/** AI-generated drafts are returned for review and are NOT saved until the teacher saves them. */
export interface GeneratedQuestionsDto {
  drafts: QuestionInput[];
  model: string;
}

// ---------------------------------------------------------------- PDF question-paper import

/** Limits for importing an existing question paper from a PDF. */
export const QUESTION_PDF_IMPORT_LIMITS = { maxMb: 20, maxPages: 30, maxDrafts: 300 } as const;

export const QUESTION_IMPORT_STATUSES = [
  'queued',
  'processing',
  'ready',
  'failed',
  'saved',
  'discarded',
] as const;
export type QuestionImportStatus = (typeof QUESTION_IMPORT_STATUSES)[number];

/** Why a draft needs the teacher's attention before it can be saved. */
export const QUESTION_IMPORT_FLAGS = [
  'answer_missing',
  'answer_conflict',
  'needs_fix',
  'has_diagram',
  'spans_pages',
  'low_confidence',
] as const;
export type QuestionImportFlag = (typeof QUESTION_IMPORT_FLAGS)[number];

export const QUESTION_IMPORT_FLAG_LABELS: Record<QuestionImportFlag, string> = {
  answer_missing: 'Answer not found: set it',
  answer_conflict: 'Answer key disagrees with the paper',
  needs_fix: 'Needs fixing',
  has_diagram: 'Has a diagram',
  spans_pages: 'Continues across pages',
  low_confidence: 'Hard to read: check carefully',
};

export interface QuestionImportDiagramDto {
  fileId: number;
  url: string;
}

/** One question extracted from the paper. `question` may be incomplete (see `problem`/`flags`). */
export interface QuestionImportDraftDto {
  /** Stable id within the import, e.g. `p2-3`. */
  id: string;
  /** Question number as printed on the paper. */
  number: string | null;
  page: number;
  question: QuestionInput;
  flags: QuestionImportFlag[];
  /** Validation problem that blocks saving as-is (null when the draft is valid). */
  problem: string | null;
  /** Model confidence 0–1 when reported. */
  confidence: number | null;
  diagrams: QuestionImportDiagramDto[];
}

export interface QuestionImportDto {
  id: number;
  bankId: number;
  status: QuestionImportStatus;
  fileName: string;
  answerKeyFileName: string | null;
  /** Signed link to the uploaded paper while the import is open. */
  fileUrl: string | null;
  pageCount: number;
  pagesDone: number;
  drafts: QuestionImportDraftDto[];
  warnings: string[];
  error: string | null;
  model: string | null;
  /** Pages sent to the image-capable model (scans, diagrams, equations). */
  visionPages: number;
  savedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionImportSaveItem {
  draftId: string;
  question: QuestionInput;
  /** Diagram files of the draft to attach; defaults to all of them. */
  diagramFileIds?: number[];
}

export interface QuestionImportSaveResult {
  created: number;
  questionIds: number[];
}

// ---------------------------------------------------------------- exams

export const EXAM_STATUSES = ['draft', 'scheduled', 'cancelled'] as const;
export type ExamStatus = (typeof EXAM_STATUSES)[number];

/** Derived from status + window for display. */
export type ExamPhase = 'draft' | 'upcoming' | 'live' | 'closed' | 'published' | 'cancelled';

export const EVALUATION_MODES = ['manual', 'ai_assist', 'ai_only'] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];

export const EVALUATION_MODE_LABELS: Record<EvaluationMode, string> = {
  manual: 'Manual evaluation',
  ai_assist: 'AI-assisted (teacher reviews)',
  ai_only: 'AI-only',
};

export interface ExamSectionDto {
  id: number;
  title: string;
  instructions: string | null;
  sortOrder: number;
  questionCount?: number;
}

export interface ExamQuestionDto {
  id: number;
  sectionId: number;
  questionId: number;
  sortOrder: number;
  marks: number;
  negativeMarks: number;
  partialMarking: boolean;
  question: QuestionDto;
}

export interface ExamDto {
  id: number;
  branchId: number | null;
  title: string;
  description: string | null;
  instructions: string | null;
  batchId: number | null;
  batchName?: string | null;
  courseId: number | null;
  courseName?: string | null;
  subjectId: number | null;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  status: ExamStatus;
  phase: ExamPhase;
  evaluationMode: EvaluationMode;
  promptVersionId: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  partialMarking: boolean;
  defaultMarks: number;
  defaultNegativeMarks: number;
  passMarks: number | null;
  totalMarks: number;
  questionCount: number;
  resultsPublishedAt: string | null;
  createdByUserId: number | null;
  createdAt: string;
}

export interface ExamDetailDto extends ExamDto {
  sections: ExamSectionDto[];
  questions: ExamQuestionDto[];
}

export interface ExamInput {
  title: string;
  description?: string | null;
  instructions?: string | null;
  batchId?: number | null;
  courseId?: number | null;
  branchId?: number | null;
  subjectId?: number | null;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  evaluationMode?: EvaluationMode;
  promptVersionId?: number | null;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  partialMarking?: boolean;
  defaultMarks?: number;
  defaultNegativeMarks?: number;
  passMarks?: number | null;
}

export interface ExamSectionInput {
  title: string;
  instructions?: string | null;
  sortOrder?: number;
}

export interface AddExamQuestionsInput {
  sectionId: number;
  questionIds: number[];
  marks?: number;
  negativeMarks?: number;
}

export interface UpdateExamQuestionInput {
  sectionId?: number;
  sortOrder?: number;
  marks?: number;
  negativeMarks?: number;
  partialMarking?: boolean;
}

// ---------------------------------------------------------------- attempts (student side)

export const ATTEMPT_STATUSES = ['in_progress', 'submitted', 'auto_submitted'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const EVALUATION_STATUSES = ['pending', 'ai_suggested', 'reviewed', 'finalized'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

/** A student's response. `options` for MCQ, `value` for numerical/true-false, `text` for descriptive. */
export interface AnswerResponse {
  options?: string[];
  value?: number | boolean | null;
  text?: string | null;
}

export interface StudentExamListItem {
  exam: ExamDto;
  attempt: { id: number; status: AttemptStatus; submittedAt: string | null } | null;
  canStart: boolean;
}

/** Question as delivered to a candidate: no answer key, explanation or marks breakdown. */
export interface DeliveredQuestion {
  examQuestionId: number;
  sectionId: number;
  type: QuestionType;
  text: string;
  options: QuestionOption[];
  assets: { id: number; url: string }[];
  marks: number;
  negativeMarks: number;
}

export interface AnswerPageDto {
  id: number;
  fileId: number;
  pageNo: number;
  url: string;
}

export interface SavedAnswerDto {
  examQuestionId: number;
  response: AnswerResponse | null;
  markedForReview: boolean;
  visited: boolean;
  timeSpentSeconds: number;
  pages: AnswerPageDto[];
}

export interface AttemptSessionDto {
  attemptId: number;
  examId: number;
  title: string;
  instructions: string | null;
  status: AttemptStatus;
  startedAt: string;
  /** Server-authoritative deadline; clients count down from `deadlineAt - serverNow`. */
  deadlineAt: string;
  serverNow: string;
  sections: ExamSectionDto[];
  questions: DeliveredQuestion[];
  answers: SavedAnswerDto[];
}

export interface SaveAnswerInput {
  response?: AnswerResponse | null;
  markedForReview?: boolean;
  visited?: boolean;
  timeSpentSeconds?: number;
}

export interface SaveAnswerResult {
  savedAt: string;
  deadlineAt: string;
  serverNow: string;
}

// ---------------------------------------------------------------- evaluation & results

export interface AttemptSummaryDto {
  id: number;
  examId: number;
  studentUserId: number;
  studentName: string | null;
  status: AttemptStatus;
  startedAt: string;
  submittedAt: string | null;
  objectiveScore: number;
  descriptiveScore: number;
  totalScore: number;
  maxScore: number;
  pendingEvaluations: number;
  rank: number | null;
  percentile: number | null;
}

export interface EvaluationDto {
  answerId: number;
  attemptId: number;
  examQuestionId: number;
  studentUserId: number;
  studentName: string | null;
  questionText: string;
  maxMarks: number;
  modelAnswer: string | null;
  rubric: string | null;
  /** The original submission, never modified after submit. */
  responseText: string | null;
  pages: AnswerPageDto[];
  status: EvaluationStatus;
  aiMarks: number | null;
  aiFeedback: string | null;
  aiConfidence: number | null;
  /** Provider/model of the AI result behind `aiMarks` (`mock` = offline mock provider). */
  aiProvider: string | null;
  aiModel: string | null;
  teacherMarks: number | null;
  teacherFeedback: string | null;
  finalMarks: number | null;
  evaluatedByName: string | null;
  evaluatedAt: string | null;
}

export interface EvaluateAnswerInput {
  /** Required unless `acceptAi` is set. */
  marks?: number;
  feedback?: string | null;
  /** Accept the AI suggestion as-is (marks must equal AI marks). */
  acceptAi?: boolean;
}

export interface ResultCorrectionInput {
  answerId: number;
  marks: number;
  reason: string;
}

export interface ResultCorrectionDto {
  id: number;
  answerId: number;
  beforeMarks: number | null;
  afterMarks: number;
  reason: string;
  correctedByName: string | null;
  createdAt: string;
}

export const GRADING_JOB_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type GradingJobStatus = (typeof GRADING_JOB_STATUSES)[number];

export interface GradingJobDto {
  id: number;
  examId: number;
  status: GradingJobStatus;
  mode: EvaluationMode;
  total: number;
  processed: number;
  failed: number;
  error: string | null;
  promptVersionId: number | null;
  /** Provider/model of the job's AI calls (null until the first call). */
  provider: string | null;
  model: string | null;
  totalTokens: number;
  imageCount: number;
  estimatedCostUsd: number;
  createdAt: string;
  finishedAt: string | null;
}

/** One AI grading call for an answer: raw output plus usage, kept for audit. */
export interface GradingResultDto {
  id: number;
  gradingJobId: number | null;
  status: 'success' | 'error';
  provider: string | null;
  model: string | null;
  marks: number | null;
  feedback: string | null;
  confidence: number | null;
  rawOutput: string | null;
  usedVision: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  imageCount: number;
  estimatedCostUsd: number;
  latencyMs: number | null;
  error: string | null;
  promptVersionId: number | null;
  createdAt: string;
}

/**
 * Append-only marks trail. Answer-level kinds record each AI result and teacher edit; `published`
 * and `unpublished` are attempt-level snapshots (`answerId` null) of the marks students saw.
 */
export const MARK_REVISION_KINDS = [
  'ai_suggestion',
  'ai_final',
  'teacher_mark',
  'teacher_accept',
  'teacher_override',
  'correction',
  'published',
  'unpublished',
] as const;
export type MarkRevisionKind = (typeof MARK_REVISION_KINDS)[number];
export type MarkRevisionSource = 'ai' | 'teacher' | 'system';

export interface MarkRevisionDto {
  id: number;
  attemptId: number;
  answerId: number | null;
  kind: MarkRevisionKind;
  source: MarkRevisionSource;
  /** For `published` snapshots: the answer's published marks (attempt total in `attemptTotal`). */
  marks: number | null;
  previousMarks: number | null;
  feedback: string | null;
  gradingResultId: number | null;
  correctionId: number | null;
  actorName: string | null;
  /** Provider/model/confidence for AI rows, reason for corrections, totals for snapshots. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Full history of one descriptive answer: submission → AI output → teacher edits → published marks. */
export interface AnswerHistoryDto {
  answerId: number;
  attemptId: number;
  examQuestionId: number;
  maxMarks: number;
  /** The original submission, never modified after submit. */
  submission: { responseText: string | null; pages: AnswerPageDto[]; submittedAt: string | null };
  current: {
    status: EvaluationStatus | null;
    aiMarks: number | null;
    teacherMarks: number | null;
    finalMarks: number | null;
    /** Marks counted in the result now (latest correction › final marks › auto score). */
    effectiveMarks: number | null;
  };
  aiResults: GradingResultDto[];
  revisions: MarkRevisionDto[];
  corrections: ResultCorrectionDto[];
  /** Marks of this answer at the most recent publish, if results were ever published. */
  published: { at: string; marks: number | null; attemptTotal: number | null } | null;
}

export interface PromptVersionDto {
  id: number;
  feature: string;
  version: number;
  name: string;
  systemPrompt: string;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
}

export interface PromptVersionInput {
  name: string;
  systemPrompt: string;
  notes?: string | null;
  activate?: boolean;
}

export interface QuestionResultDto {
  examQuestionId: number;
  /** Null when the candidate never saved an answer row for the question. */
  answerId: number | null;
  sectionId: number;
  type: QuestionType;
  text: string;
  options: QuestionOption[];
  response: AnswerResponse | null;
  pages: AnswerPageDto[];
  correct: AnswerKey | null;
  explanation: string | null;
  isCorrect: boolean | null;
  marks: number | null;
  maxMarks: number;
  feedback: string | null;
  chapterName: string | null;
  topicName: string | null;
}

export interface ResultDto {
  attempt: AttemptSummaryDto;
  exam: ExamDto;
  passed: boolean | null;
  sections: { id: number; title: string; score: number; maxScore: number }[];
  chapters: TopicStat[];
  questions: QuestionResultDto[];
  corrections: ResultCorrectionDto[];
}

export interface TopicStat {
  key: string;
  chapterName: string | null;
  topicName: string | null;
  score: number;
  maxScore: number;
  /** 0..100 */
  accuracy: number;
}

export interface ExamAnalyticsDto {
  examId: number;
  attempts: number;
  submitted: number;
  eligible: number;
  average: number;
  highest: number;
  lowest: number;
  median: number;
  passCount: number | null;
  distribution: { range: string; count: number }[];
  topics: TopicStat[];
  questions: {
    examQuestionId: number;
    text: string;
    type: QuestionType;
    attempted: number;
    correct: number;
    averageMarks: number;
    maxMarks: number;
  }[];
}

export interface ChildResultListItem {
  studentUserId: number;
  studentName: string;
  attemptId: number;
  exam: ExamDto;
  totalScore: number;
  maxScore: number;
  rank: number | null;
  percentile: number | null;
}
