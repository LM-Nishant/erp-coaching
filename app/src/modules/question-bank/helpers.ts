import { ref } from 'vue';
import type { AnswerKey, QuestionType, SubjectDto } from '@erp/shared';
import { academicsApi, type ChapterWithTopics } from '@/modules/academics/api';

export const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

export const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'success',
  medium: 'warning',
  hard: 'danger',
};
export const STATUS_COLORS: Record<string, string> = { draft: 'medium', active: 'success', archived: 'dark' };

export const hasOptions = (t: QuestionType) => t === 'single' || t === 'multiple';

export const snippet = (text: string, n = 140) => {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function answerSummary(type: QuestionType, k: AnswerKey): string {
  switch (type) {
    case 'single':
    case 'multiple':
      return k.options?.length ? k.options.join(', ') : '—';
    case 'true_false':
      return k.value === true ? 'True' : k.value === false ? 'False' : '—';
    case 'numerical':
      if (k.min != null || k.max != null) return `${k.min ?? '−∞'} to ${k.max ?? '∞'}`;
      if (k.value == null) return '—';
      return k.tolerance ? `${k.value} ± ${k.tolerance}` : String(k.value);
    case 'descriptive':
      return k.modelAnswer ? snippet(k.modelAnswer, 80) : 'Evaluated manually';
  }
}

export const parseTags = (s: string) =>
  Array.from(
    new Set(
      s
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  );

/** Subject → chapter → topic pickers backed by the academics module (silently empty without access). */
export function useAcademicPickers() {
  const subjects = ref<SubjectDto[]>([]);
  const chapters = ref<ChapterWithTopics[]>([]);

  async function loadSubjects() {
    try {
      subjects.value = await academicsApi.subjects();
    } catch {
      subjects.value = [];
    }
  }

  async function loadChapters(subjectId: number | null | undefined) {
    if (!subjectId) {
      chapters.value = [];
      return;
    }
    try {
      chapters.value = await academicsApi.chapters(subjectId);
    } catch {
      chapters.value = [];
    }
  }

  const topicsOf = (chapterId: number | null | undefined) =>
    chapters.value.find((c) => c.id === chapterId)?.topics ?? [];

  return { subjects, chapters, loadSubjects, loadChapters, topicsOf };
}
