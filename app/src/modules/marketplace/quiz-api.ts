import type {
  MktCertificateDto,
  MktCertificateVerifyDto,
  MktQuizAttemptInput,
  MktQuizDto,
  MktQuizInput,
  MktQuizLearnerDto,
  MktQuizResultDto,
} from '@erp/shared';
import { API_URL, api } from '@/core/api';
import type { StudioScope } from './api';

const anon = { anonymous: true };
const learning = (courseId: number, lectureId: number) =>
  `/marketplace/learning/${courseId}/lectures/${lectureId}/quiz`;

/** Quizzes (learner and seller) and completion certificates. */
export const quizApi = {
  quiz: (courseId: number, lectureId: number) => api.get<MktQuizLearnerDto>(learning(courseId, lectureId)),
  submit: (courseId: number, lectureId: number, body: MktQuizAttemptInput) =>
    api.post<MktQuizResultDto>(`${learning(courseId, lectureId)}/attempts`, body),
  attempt: (courseId: number, lectureId: number, attemptId: number) =>
    api.get<MktQuizResultDto>(`${learning(courseId, lectureId)}/attempts/${attemptId}`),

  studio: (scope: StudioScope) => {
    const base = (id: number, lectureId: number) =>
      `/marketplace/${scope}/courses/${id}/lectures/${lectureId}/quiz`;
    return {
      get: (id: number, lectureId: number) => api.get<MktQuizDto>(base(id, lectureId)),
      save: (id: number, lectureId: number, input: MktQuizInput) =>
        api.put<MktQuizDto>(base(id, lectureId), input),
      importFromBank: (id: number, lectureId: number, questionIds: number[]) =>
        api.post<MktQuizDto>(`${base(id, lectureId)}/import`, { questionIds }),
    };
  },
  review: (id: number, lectureId: number) =>
    api.get<MktQuizDto>(`/admin/marketplace/courses/${id}/lectures/${lectureId}/quiz`),

  certificates: () => api.get<MktCertificateDto[]>('/marketplace/certificates'),
  verify: (code: string) =>
    api.get<MktCertificateVerifyDto>(
      `/marketplace/public/certificates/${encodeURIComponent(code)}`,
      undefined,
      anon,
    ),
};

/** Public PDF of a certificate (no sign-in needed, so it works as a plain link). */
export const certificatePdfUrl = (code: string, download = true) =>
  `${API_URL}/api/marketplace/public/certificates/${encodeURIComponent(code)}/pdf?download=${download ? 1 : 0}`;
