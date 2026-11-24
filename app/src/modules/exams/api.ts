import { formatDateTime as coreFormatDateTime } from '@/core/format';
import type {
  AddExamQuestionsInput,
  AiAvailabilityDto,
  AnswerHistoryDto,
  AnswerPageDto,
  AttemptSessionDto,
  AttemptSummaryDto,
  ChildResultListItem,
  EvaluateAnswerInput,
  EvaluationDto,
  EvaluationStatus,
  ExamAnalyticsDto,
  ExamDetailDto,
  ExamDto,
  ExamInput,
  ExamPhase,
  ExamSectionDto,
  ExamSectionInput,
  GradingJobDto,
  GradingResultDto,
  MarkRevisionKind,
  Paginated,
  PromptVersionDto,
  PromptVersionInput,
  ResultCorrectionInput,
  ResultDto,
  SaveAnswerInput,
  SaveAnswerResult,
  StudentExamListItem,
  UpdateExamQuestionInput,
} from '@erp/shared';
import { api } from '@/core/api';
import { saveFile } from '@/core/downloads';

const E = '/exams';

export interface ExamFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  phase?: ExamPhase | '';
  batchId?: number | null;
  courseId?: number | null;
  q?: string;
}

export interface PromptVersionList {
  defaultPrompt: string;
  versions: PromptVersionDto[];
}

export function fileForm(file: Blob, name: string, fields: Record<string, string> = {}) {
  const f = new FormData();
  Object.entries(fields).forEach(([k, v]) => f.append(k, v));
  f.append('file', file, name);
  return f;
}

export const examsApi = {
  // Staff: authoring
  list: (f: ExamFilters) => api.get<Paginated<ExamDto>>(E, { ...f }),
  get: (id: number) => api.get<ExamDetailDto>(`${E}/${id}`),
  create: (b: ExamInput) => api.post<ExamDetailDto>(E, b),
  update: (id: number, b: Partial<ExamInput>) => api.patch<ExamDetailDto>(`${E}/${id}`, b),
  remove: (id: number) => api.delete(`${E}/${id}`),
  schedule: (id: number) => api.post<ExamDetailDto>(`${E}/${id}/schedule`),
  cancel: (id: number, reason?: string) => api.post<ExamDetailDto>(`${E}/${id}/cancel`, { reason }),
  duplicate: (id: number) => api.post<ExamDetailDto>(`${E}/${id}/duplicate`),
  addSection: (id: number, b: ExamSectionInput) => api.post<ExamSectionDto>(`${E}/${id}/sections`, b),
  updateSection: (id: number, sectionId: number, b: Partial<ExamSectionInput>) =>
    api.patch(`${E}/${id}/sections/${sectionId}`, b),
  removeSection: (id: number, sectionId: number) => api.delete(`${E}/${id}/sections/${sectionId}`),
  addQuestions: (id: number, b: AddExamQuestionsInput) => api.post<ExamDetailDto>(`${E}/${id}/questions`, b),
  updateQuestion: (id: number, eqId: number, b: UpdateExamQuestionInput) =>
    api.patch<ExamDetailDto>(`${E}/${id}/questions/${eqId}`, b),
  removeQuestion: (id: number, eqId: number) => api.delete(`${E}/${id}/questions/${eqId}`),
  refreshQuestion: (id: number, eqId: number) =>
    api.post<ExamDetailDto>(`${E}/${id}/questions/${eqId}/refresh`),

  // Staff: results & evaluation
  attempts: (id: number) => api.get<AttemptSummaryDto[]>(`${E}/${id}/attempts`),
  attemptResult: (id: number, attemptId: number) => api.get<ResultDto>(`${E}/${id}/attempts/${attemptId}`),
  staffScorecard: (id: number, attemptId: number) =>
    download(`${E}/${id}/attempts/${attemptId}/scorecard.pdf`, `scorecard-${attemptId}.pdf`),
  evaluations: (
    id: number,
    q: { status?: EvaluationStatus | ''; examQuestionId?: number; attemptId?: number } = {},
  ) => api.get<EvaluationDto[]>(`${E}/${id}/evaluations`, q),
  evaluate: (id: number, answerId: number, b: EvaluateAnswerInput) =>
    api.put<EvaluationDto>(`${E}/${id}/evaluations/${answerId}`, b),
  aiHistory: (id: number, answerId: number) =>
    api.get<GradingResultDto[]>(`${E}/${id}/evaluations/${answerId}/ai-history`),
  answerHistory: (id: number, answerId: number) =>
    api.get<AnswerHistoryDto>(`${E}/${id}/evaluations/${answerId}/history`),
  aiStatus: () => api.get<AiAvailabilityDto>(`${E}/ai-status`),
  gradingJobs: (id: number) => api.get<GradingJobDto[]>(`${E}/${id}/grading-jobs`),
  startGrading: (id: number, regrade = false) =>
    api.post<GradingJobDto>(`${E}/${id}/grading-jobs`, { regrade }),
  analytics: (id: number) => api.get<ExamAnalyticsDto>(`${E}/${id}/analytics`),
  resultsCsv: (id: number) => download(`${E}/${id}/results.csv`, `exam-${id}-results.csv`),
  publish: (id: number) => api.post<ExamDto>(`${E}/${id}/publish`),
  unpublish: (id: number) => api.post<ExamDto>(`${E}/${id}/unpublish`),
  correct: (id: number, b: ResultCorrectionInput) => api.post<ResultDto>(`${E}/${id}/corrections`, b),

  // Prompt versions (exams.configure)
  promptVersions: () => api.get<PromptVersionList>(`${E}/prompt-versions`),
  createPromptVersion: (b: PromptVersionInput) => api.post<PromptVersionDto>(`${E}/prompt-versions`, b),
  activatePromptVersion: (id: number | null) =>
    api.post<PromptVersionList>(`${E}/prompt-versions/activate`, { id }),

  // Student
  myExams: () => api.get<StudentExamListItem[]>(`${E}/my`),
  start: (examId: number) => api.post<AttemptSessionDto>(`${E}/my/${examId}/start`),
  resume: (attemptId: number) => api.get<AttemptSessionDto>(`${E}/my/attempts/${attemptId}`),
  save: (attemptId: number, eqId: number, b: SaveAnswerInput) =>
    api.put<SaveAnswerResult>(`${E}/my/attempts/${attemptId}/answers/${eqId}`, b),
  uploadPage: (attemptId: number, eqId: number, file: Blob, name: string) =>
    api.post<AnswerPageDto[]>(`${E}/my/attempts/${attemptId}/answers/${eqId}/pages`, fileForm(file, name)),
  reorderPages: (attemptId: number, eqId: number, pageIds: number[]) =>
    api.put<AnswerPageDto[]>(`${E}/my/attempts/${attemptId}/answers/${eqId}/pages/order`, { pageIds }),
  removePage: (attemptId: number, eqId: number, pageId: number) =>
    api.delete<AnswerPageDto[]>(`${E}/my/attempts/${attemptId}/answers/${eqId}/pages/${pageId}`),
  submit: (attemptId: number) =>
    api.post<{ id: number; status: string; submittedAt: string }>(`${E}/my/attempts/${attemptId}/submit`),
  myResults: () => api.get<ChildResultListItem[]>(`${E}/my/results`),
  myResult: (attemptId: number) => api.get<ResultDto>(`${E}/my/results/${attemptId}`),
  myScorecard: (attemptId: number) =>
    download(`${E}/my/results/${attemptId}/scorecard.pdf`, `scorecard-${attemptId}.pdf`),

  // Parent
  childrenResults: () => api.get<ChildResultListItem[]>(`${E}/children/results`),
  childResult: (attemptId: number) => api.get<ResultDto>(`${E}/children/results/${attemptId}`),
  childScorecard: (attemptId: number) =>
    download(`${E}/children/results/${attemptId}/scorecard.pdf`, `scorecard-${attemptId}.pdf`),
};

/** Downloads a file (PDF/CSV) and saves it: a browser download, or the share sheet on a device. */
export async function download(path: string, fallbackName: string) {
  const file = await api.download(path);
  await saveFile(file.blob, file.fileName ?? fallbackName);
}

export const PHASE_COLORS: Record<ExamPhase, string> = {
  draft: 'medium',
  upcoming: 'primary',
  live: 'success',
  closed: 'warning',
  published: 'tertiary',
  cancelled: 'danger',
};

export const EVAL_STATUS_COLORS: Record<EvaluationStatus, string> = {
  pending: 'warning',
  ai_suggested: 'tertiary',
  reviewed: 'primary',
  finalized: 'success',
};

export const REVISION_LABELS: Record<MarkRevisionKind, string> = {
  ai_suggestion: 'AI suggestion',
  ai_final: 'AI marks (final)',
  teacher_mark: 'Teacher marks',
  teacher_accept: 'Teacher accepted AI',
  teacher_override: 'Teacher override',
  correction: 'Result correction',
  published: 'Results published',
  unpublished: 'Results unpublished',
};

export const formatDate = (iso: string | null | undefined) => (iso ? coreFormatDateTime(iso) : '—');
export const fmtMarks = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2);
