import type {
  GenerateQuestionsInput,
  GeneratedQuestionsDto,
  Paginated,
  QuestionBankDto,
  QuestionBankInput,
  QuestionDto,
  QuestionImportResult,
  QuestionInput,
} from '@erp/shared';
import { api } from '@/core/api';
import { download, fileForm } from '@/modules/exams/api';

const QB = '/question-bank';

export interface QuestionFilters {
  page?: number;
  pageSize?: number;
  bankId?: number | null;
  type?: string;
  difficulty?: string;
  status?: string;
  subjectId?: number | null;
  chapterId?: number | null;
  topicId?: number | null;
  tag?: string;
  q?: string;
}

export const questionBankApi = {
  banks: (q: { subjectId?: number; q?: string } = {}) => api.get<QuestionBankDto[]>(`${QB}/banks`, q),
  bank: (id: number) => api.get<QuestionBankDto>(`${QB}/banks/${id}`),
  saveBank: (b: Partial<QuestionBankInput>, id?: number) =>
    id ? api.patch<QuestionBankDto>(`${QB}/banks/${id}`, b) : api.post<QuestionBankDto>(`${QB}/banks`, b),
  removeBank: (id: number) => api.delete(`${QB}/banks/${id}`),

  questions: (f: QuestionFilters) => api.get<Paginated<QuestionDto>>(`${QB}/questions`, { ...f }),
  question: (id: number) => api.get<QuestionDto>(`${QB}/questions/${id}`),
  createQuestion: (bankId: number, b: QuestionInput) =>
    api.post<QuestionDto>(`${QB}/banks/${bankId}/questions`, b),
  createQuestions: (bankId: number, questions: QuestionInput[]) =>
    api.post<QuestionDto[]>(`${QB}/banks/${bankId}/questions/bulk`, { questions }),
  updateQuestion: (id: number, b: Partial<QuestionInput>) =>
    api.patch<QuestionDto>(`${QB}/questions/${id}`, b),
  removeQuestion: (id: number) => api.delete(`${QB}/questions/${id}`),
  addAsset: (id: number, file: Blob, name: string, role: 'question' | 'explanation' = 'question') =>
    api.post<QuestionDto>(`${QB}/questions/${id}/assets`, fileForm(file, name, { role })),
  removeAsset: (id: number, assetId: number) =>
    api.delete<QuestionDto>(`${QB}/questions/${id}/assets/${assetId}`),
  optionImage: (bankId: number, file: Blob, name: string) =>
    api.post<{ fileId: number; url: string }>(`${QB}/banks/${bankId}/option-images`, fileForm(file, name)),

  importFile: (bankId: number, file: File) =>
    api.post<QuestionImportResult>(`${QB}/banks/${bankId}/import`, fileForm(file, file.name)),
  generate: (b: GenerateQuestionsInput) => api.post<GeneratedQuestionsDto>(`${QB}/generate`, b),
  exportCsv: (bankId: number) => download(`${QB}/banks/${bankId}/export.csv`, `question-bank-${bankId}.csv`),
  template: () => download(`${QB}/import-template.csv`, 'question-import-template.csv'),
};
