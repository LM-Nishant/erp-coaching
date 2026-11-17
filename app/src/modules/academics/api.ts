import type {
  AcademicSessionDto,
  BatchDto,
  BatchStudentDto,
  ChapterDto,
  ClassNoteCommentDto,
  ClassNoteDto,
  ClassroomDto,
  ClassSessionDto,
  CourseCategoryDto,
  CourseDto,
  GenerateSessionsRequest,
  GenerateSessionsResult,
  PromotionRequest,
  PromotionResult,
  RescheduleRequest,
  ScheduleDto,
  SubjectDto,
  TopicDto,
} from '@erp/shared';
import { api } from '@/core/api';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface PersonRef {
  id: number;
  name: string;
  mobile: string;
  branchIds: number[];
}
export interface BranchRef {
  id: number;
  name: string;
}
export type ChapterWithTopics = ChapterDto & { topics: TopicDto[] };
type Q = Record<string, string | number | boolean | undefined | null>;
type Body = Record<string, unknown>;

const A = '/academics';

export const academicsApi = {
  branches: () => api.get<BranchRef[]>('/branches'),
  teachers: (search?: string) => api.get<PersonRef[]>(`${A}/teachers`, { search }),
  students: (search?: string) => api.get<PersonRef[]>(`${A}/students`, { search }),

  sessions: () => api.get<AcademicSessionDto[]>(`${A}/sessions`),
  saveSession: (b: Body, id?: number) =>
    id
      ? api.patch<AcademicSessionDto>(`${A}/sessions/${id}`, b)
      : api.post<AcademicSessionDto>(`${A}/sessions`, b),
  makeCurrent: (id: number) => api.post<AcademicSessionDto>(`${A}/sessions/${id}/make-current`),
  removeSession: (id: number) => api.delete(`${A}/sessions/${id}`),

  categories: () => api.get<CourseCategoryDto[]>(`${A}/course-categories`),
  saveCategory: (b: Body, id?: number) =>
    id ? api.patch(`${A}/course-categories/${id}`, b) : api.post(`${A}/course-categories`, b),
  removeCategory: (id: number) => api.delete(`${A}/course-categories/${id}`),

  courses: (q: Q = {}) => api.get<Page<CourseDto>>(`${A}/courses`, { pageSize: 100, ...q }),
  saveCourse: (b: Body, id?: number) =>
    id ? api.patch<CourseDto>(`${A}/courses/${id}`, b) : api.post<CourseDto>(`${A}/courses`, b),
  cloneCourse: (id: number, b: Body) => api.post<CourseDto>(`${A}/courses/${id}/clone`, b),
  removeCourse: (id: number) => api.delete(`${A}/courses/${id}`),

  subjects: (courseId?: number) => api.get<SubjectDto[]>(`${A}/subjects`, { courseId }),
  saveSubject: (b: Body, id?: number) =>
    id ? api.patch(`${A}/subjects/${id}`, b) : api.post(`${A}/subjects`, b),
  removeSubject: (id: number) => api.delete(`${A}/subjects/${id}`),
  chapters: (subjectId: number) => api.get<ChapterWithTopics[]>(`${A}/subjects/${subjectId}/chapters`),
  saveChapter: (b: Body, id?: number) =>
    id ? api.patch(`${A}/chapters/${id}`, b) : api.post(`${A}/chapters`, b),
  removeChapter: (id: number) => api.delete(`${A}/chapters/${id}`),
  saveTopic: (b: Body, id?: number) => (id ? api.patch(`${A}/topics/${id}`, b) : api.post(`${A}/topics`, b)),
  removeTopic: (id: number) => api.delete(`${A}/topics/${id}`),

  batches: (q: Q = {}) => api.get<Page<BatchDto>>(`${A}/batches`, { pageSize: 100, ...q }),
  saveBatch: (b: Body, id?: number) =>
    id ? api.patch<BatchDto>(`${A}/batches/${id}`, b) : api.post<BatchDto>(`${A}/batches`, b),
  setTeachers: (id: number, teachers: { teacherUserId: number; subjectId?: number | null }[]) =>
    api.put<BatchDto>(`${A}/batches/${id}/teachers`, { teachers }),
  removeBatch: (id: number) => api.delete(`${A}/batches/${id}`),
  roster: (id: number, status?: string) =>
    api.get<BatchStudentDto[]>(`${A}/batches/${id}/students`, { status }),
  enroll: (id: number, studentUserIds: number[]) =>
    api.post(`${A}/batches/${id}/students`, { studentUserIds }),
  unenroll: (id: number, studentUserId: number) => api.delete(`${A}/batches/${id}/students/${studentUserId}`),
  promote: (b: PromotionRequest) => api.post<PromotionResult>(`${A}/promotions`, b),

  classrooms: (q: Q = {}) => api.get<ClassroomDto[]>(`${A}/classrooms`, q),
  saveClassroom: (b: Body, id?: number) =>
    id ? api.patch(`${A}/classrooms/${id}`, b) : api.post(`${A}/classrooms`, b),
  removeClassroom: (id: number) => api.delete(`${A}/classrooms/${id}`),

  schedules: (q: Q = {}) => api.get<ScheduleDto[]>(`${A}/schedules`, q),
  saveSchedule: (b: Body, id?: number) =>
    id ? api.patch<ScheduleDto>(`${A}/schedules/${id}`, b) : api.post<ScheduleDto>(`${A}/schedules`, b),
  removeSchedule: (id: number) => api.delete(`${A}/schedules/${id}`),
  generate: (b: GenerateSessionsRequest) => api.post<GenerateSessionsResult>(`${A}/schedules/generate`, b),

  classSessions: (q: Q = {}) =>
    api.get<Page<ClassSessionDto>>(`${A}/class-sessions`, { pageSize: 500, ...q }),
  classSession: (id: number) => api.get<ClassSessionDto>(`${A}/class-sessions/${id}`),
  createClassSession: (b: Body) => api.post<ClassSessionDto>(`${A}/class-sessions`, b),
  reschedule: (id: number, b: RescheduleRequest) =>
    api.post<ClassSessionDto>(`${A}/class-sessions/${id}/reschedule`, b),
  cancel: (id: number, reason: string) =>
    api.post<ClassSessionDto>(`${A}/class-sessions/${id}/cancel`, { reason }),
  substitute: (id: number, teacherUserId: number) =>
    api.post<ClassSessionDto>(`${A}/class-sessions/${id}/substitute`, { teacherUserId }),
  complete: (id: number, b: { actualDurationMinutes: number; completionNotes?: string | null }) =>
    api.post<ClassSessionDto>(`${A}/class-sessions/${id}/complete`, b),
  myTimetable: (from?: string, to?: string) =>
    api.get<{ from: string; to: string; items: ClassSessionDto[] }>(`${A}/my-timetable`, { from, to }),

  notes: (classSessionId: number) => api.get<ClassNoteDto[]>(`${A}/class-sessions/${classSessionId}/notes`),
  addNote: (classSessionId: number, b: Body) =>
    api.post<ClassNoteDto>(`${A}/class-sessions/${classSessionId}/notes`, b),
  updateNote: (id: number, b: Body) => api.patch<ClassNoteDto>(`${A}/class-notes/${id}`, b),
  removeNote: (id: number) => api.delete(`${A}/class-notes/${id}`),
  comment: (noteId: number, body: string) =>
    api.post<ClassNoteCommentDto>(`${A}/class-notes/${noteId}/comments`, { body }),
  removeComment: (id: number) => api.delete(`${A}/class-note-comments/${id}`),
};

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const isoToday = () => new Date().toISOString().slice(0, 10);
export const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const weekdayOf = (date: string) => DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
export const statusColor = (s: string) =>
  ({ completed: 'success', cancelled: 'danger', scheduled: 'primary', active: 'success', planned: 'medium' })[
    s
  ] ?? 'medium';
