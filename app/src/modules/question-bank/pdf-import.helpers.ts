import type {
  AnswerKey,
  QuestionDifficulty,
  QuestionImportDraftDto,
  QuestionImportDto,
  QuestionImportFlag,
  QuestionImportSaveItem,
  QuestionInput,
  QuestionType,
} from '@erp/shared';
import { OPTION_KEYS, hasOptions } from './helpers';

/** A draft as edited on the review screen (form-friendly answer fields). */
export interface ReviewDraft {
  id: string;
  number: string | null;
  page: number;
  flags: QuestionImportFlag[];
  confidence: number | null;
  diagrams: { fileId: number; url: string; keep: boolean }[];
  selected: boolean;
  type: QuestionType;
  text: string;
  options: { key: string; text: string }[];
  correct: string[];
  trueFalse: 'true' | 'false' | '';
  numValue: string;
  numTolerance: string;
  modelAnswer: string;
  explanation: string;
}

export interface ImportDefaults {
  subjectId: number | null;
  chapterId: number | null;
  topicId: number | null;
  difficulty: QuestionDifficulty;
  defaultMarks: number;
  defaultNegativeMarks: number;
}

/** Flags that mean the teacher must look at the draft (the others are informational). */
export const ATTENTION_FLAGS: QuestionImportFlag[] = [
  'answer_missing',
  'answer_conflict',
  'needs_fix',
  'low_confidence',
];

export const FLAG_COLORS: Record<QuestionImportFlag, string> = {
  answer_missing: 'danger',
  answer_conflict: 'danger',
  needs_fix: 'danger',
  low_confidence: 'warning',
  has_diagram: 'tertiary',
  spans_pages: 'medium',
};

export function toReviewDraft(d: QuestionImportDraftDto): ReviewDraft {
  const q = d.question;
  const k = q.answerKey ?? {};
  const options = (q.options ?? []).map((o) => ({ key: o.key, text: o.text }));
  const r: ReviewDraft = {
    id: d.id,
    number: d.number,
    page: d.page,
    flags: d.flags,
    confidence: d.confidence,
    diagrams: d.diagrams.map((g) => ({ ...g, keep: true })),
    selected: false,
    type: q.type,
    text: q.text,
    options,
    correct: [...(k.options ?? [])],
    trueFalse: k.value === true ? 'true' : k.value === false ? 'false' : '',
    numValue: typeof k.value === 'number' ? String(k.value) : '',
    numTolerance: typeof k.tolerance === 'number' && k.tolerance ? String(k.tolerance) : '',
    modelAnswer: k.modelAnswer ?? '',
    explanation: q.explanation ?? '',
  };
  if (q.type === 'numerical' && typeof k.min === 'number' && typeof k.max === 'number') {
    r.numValue = String((k.min + k.max) / 2);
    r.numTolerance = String((k.max - k.min) / 2);
  }
  r.selected = !needsAttention(r);
  return r;
}

/** Ensures MCQ drafts have at least two option rows and drops stale answers when the type changes. */
export function changeType(r: ReviewDraft, type: QuestionType) {
  r.type = type;
  if (hasOptions(type)) {
    while (r.options.length < 2) r.options.push({ key: OPTION_KEYS[r.options.length], text: '' });
    r.correct = r.correct.filter((c) => r.options.some((o) => o.key === c));
    if (type === 'single' && r.correct.length > 1) r.correct = r.correct.slice(0, 1);
  }
}

export function toggleCorrect(r: ReviewDraft, key: string) {
  if (r.type === 'single') r.correct = r.correct[0] === key ? [] : [key];
  else r.correct = r.correct.includes(key) ? r.correct.filter((k) => k !== key) : [...r.correct, key].sort();
}

export function addOption(r: ReviewDraft) {
  const key = OPTION_KEYS.find((k) => !r.options.some((o) => o.key === k));
  if (key) r.options.push({ key, text: '' });
}

export function removeOption(r: ReviewDraft, key: string) {
  r.options = r.options.filter((o) => o.key !== key);
  r.correct = r.correct.filter((k) => k !== key);
}

function answerKeyOf(r: ReviewDraft): AnswerKey {
  switch (r.type) {
    case 'single':
    case 'multiple':
      return { options: [...r.correct].sort() };
    case 'true_false':
      return r.trueFalse ? { value: r.trueFalse === 'true' } : {};
    case 'numerical': {
      const value = Number(r.numValue);
      if (r.numValue.trim() === '' || !Number.isFinite(value)) return {};
      const tol = Number(r.numTolerance);
      return { value, tolerance: r.numTolerance.trim() && Number.isFinite(tol) ? Math.abs(tol) : 0 };
    }
    case 'descriptive':
      return r.modelAnswer.trim() ? { modelAnswer: r.modelAnswer.trim() } : {};
  }
}

/** Why a draft cannot be saved yet (mirrors the server rules), or null. */
export function reviewProblem(r: ReviewDraft): string | null {
  if (!r.text.trim()) return 'Enter the question text';
  switch (r.type) {
    case 'single':
    case 'multiple': {
      const opts = r.options.filter((o) => o.text.trim());
      if (opts.length < 2 || opts.length !== r.options.length)
        return 'Every option needs text (at least two)';
      if (!r.correct.length) return 'Mark the correct option';
      if (r.type === 'single' && r.correct.length > 1)
        return 'Single-correct questions need exactly one answer';
      return null;
    }
    case 'true_false':
      return r.trueFalse ? null : 'Choose True or False';
    case 'numerical':
      return 'value' in answerKeyOf(r) ? null : 'Enter the numeric answer';
    case 'descriptive':
      return null;
  }
}

export const needsAttention = (r: ReviewDraft) =>
  !!reviewProblem(r) || r.flags.some((f) => ATTENTION_FLAGS.includes(f));

export function reviewToQuestion(r: ReviewDraft, defaults: ImportDefaults): QuestionInput {
  return {
    type: r.type,
    text: r.text.trim(),
    options: hasOptions(r.type) ? r.options.map((o) => ({ key: o.key, text: o.text.trim() })) : undefined,
    answerKey: answerKeyOf(r),
    explanation: r.explanation.trim() || null,
    difficulty: defaults.difficulty,
    subjectId: defaults.subjectId,
    chapterId: defaults.chapterId,
    topicId: defaults.topicId,
    defaultMarks: Number(defaults.defaultMarks) || 0,
    defaultNegativeMarks: Number(defaults.defaultNegativeMarks) || 0,
    status: 'active',
    source: 'import',
  };
}

export function buildSaveItems(drafts: ReviewDraft[], defaults: ImportDefaults): QuestionImportSaveItem[] {
  return drafts
    .filter((d) => d.selected)
    .map((d) => ({
      draftId: d.id,
      question: reviewToQuestion(d, defaults),
      diagramFileIds: d.diagrams.filter((g) => g.keep).map((g) => g.fileId),
    }));
}

export const isWorking = (imp: Pick<QuestionImportDto, 'status'> | null) =>
  !!imp && (imp.status === 'queued' || imp.status === 'processing');

export function progressOf(imp: Pick<QuestionImportDto, 'pageCount' | 'pagesDone'>): number {
  return imp.pageCount ? Math.min(1, imp.pagesDone / imp.pageCount) : 0;
}
