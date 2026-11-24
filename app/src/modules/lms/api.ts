import { formatDateTime } from '@/core/format';
import type {
  LmsAssignmentDto,
  LmsAssignmentInput,
  LmsCourseContentsDto,
  LmsFileRef,
  LmsGradeInput,
  LmsGrantDto,
  LmsGrantInput,
  LmsLearnerResourceDto,
  LmsLibraryCourseDto,
  LmsOfflineLicenseDto,
  LmsOfflineLicenseSummary,
  LmsPlaybackDto,
  LmsProgressDto,
  LmsProgressInput,
  LmsResourceAnalyticsRow,
  LmsResourceDto,
  LmsResourceInput,
  LmsSubmissionDto,
  LmsSubmitInput,
} from '@erp/shared';
import { api } from '@/core/api';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
type Q = Record<string, string | number | boolean | undefined | null>;

export interface ChildCourses {
  student: { id: number; name: string };
  courses: LmsLibraryCourseDto[];
}

const L = '/lms';

export const lmsApi = {
  // staff: content management
  resources: (q: Q = {}) => api.get<Page<LmsResourceDto>>(`${L}/resources`, { pageSize: 100, ...q }),
  resource: (id: number) => api.get<LmsResourceDto>(`${L}/resources/${id}`),
  learnerResource: (id: number) => api.get<LmsLearnerResourceDto>(`${L}/resources/${id}`),
  saveResource: (b: Partial<LmsResourceInput>, id?: number) =>
    id ? api.patch<LmsResourceDto>(`${L}/resources/${id}`, b) : api.post<LmsResourceDto>(`${L}/resources`, b),
  removeResource: (id: number) => api.delete(`${L}/resources/${id}`),
  setStatus: (id: number, action: 'publish' | 'unpublish' | 'archive') =>
    api.post<LmsResourceDto>(`${L}/resources/${id}/${action}`),
  transcode: (id: number) => api.post<LmsResourceDto>(`${L}/resources/${id}/transcode`),
  analytics: (id: number) => api.get<LmsResourceAnalyticsRow[]>(`${L}/resources/${id}/analytics`),
  /** Small attachments (homework files, notes) in one request. Videos use the chunked uploader. */
  uploadFile: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return api.post<LmsFileRef>(`${L}/files`, form);
  },

  // learners
  library: () => api.get<LmsLibraryCourseDto[]>(`${L}/library`),
  contents: (courseId: number) => api.get<LmsCourseContentsDto>(`${L}/courses/${courseId}/contents`),
  play: (id: number, prefer?: 'hls' | 'mp4') =>
    api.post<LmsPlaybackDto>(`${L}/resources/${id}/play`, { prefer }),
  download: (id: number) =>
    api.post<{ url: string; expiresAt: string; fileName: string }>(`${L}/resources/${id}/download`),
  progress: (id: number, b: LmsProgressInput) => api.put<LmsProgressDto>(`${L}/resources/${id}/progress`, b),
  offlineLicense: (id: number) => api.post<LmsOfflineLicenseDto>(`${L}/resources/${id}/offline-license`),
  offlineLicenses: () =>
    api.get<(LmsOfflineLicenseSummary & { contentKey: string | null })[]>(`${L}/offline-licenses`),
  revokeOffline: (id: number) => api.delete(`${L}/offline-licenses/${id}`),
  children: () => api.get<ChildCourses[]>(`${L}/children`),

  // manual access grants
  grants: (q: Q = {}) => api.get<Page<LmsGrantDto>>(`${L}/grants`, { pageSize: 100, ...q }),
  createGrant: (b: LmsGrantInput) => api.post<LmsGrantDto>(`${L}/grants`, b),
  revokeGrant: (id: number) => api.delete(`${L}/grants/${id}`),

  // homework
  /** The learner's recently watched, unfinished lessons, newest first. */
  continue: () => api.get<LmsLearnerResourceDto[]>(`${L}/continue`),
  assignments: (q: Q = {}) => api.get<Page<LmsAssignmentDto>>(`${L}/assignments`, { pageSize: 100, ...q }),
  childrenAssignments: (q: Q = {}) => api.get<LmsAssignmentDto[]>(`${L}/assignments/children`, q),
  assignment: (id: number) => api.get<LmsAssignmentDto>(`${L}/assignments/${id}`),
  saveAssignment: (b: Partial<LmsAssignmentInput>, id?: number) =>
    id
      ? api.patch<LmsAssignmentDto>(`${L}/assignments/${id}`, b)
      : api.post<LmsAssignmentDto>(`${L}/assignments`, b),
  removeAssignment: (id: number) => api.delete(`${L}/assignments/${id}`),
  publishAssignment: (id: number) => api.post<LmsAssignmentDto>(`${L}/assignments/${id}/publish`),
  closeAssignment: (id: number) => api.post<LmsAssignmentDto>(`${L}/assignments/${id}/close`),
  submissions: (id: number) => api.get<LmsSubmissionDto[]>(`${L}/assignments/${id}/submissions`),
  submit: (id: number, b: LmsSubmitInput) =>
    api.put<LmsSubmissionDto>(`${L}/assignments/${id}/submission`, b),
  grade: (submissionId: number, b: LmsGradeInput) =>
    api.post<LmsSubmissionDto>(`${L}/submissions/${submissionId}/grade`, b),
};

export const RESOURCE_TYPE_LABEL: Record<string, string> = {
  video: 'Video lecture',
  notes: 'Notes',
  ppt: 'Presentation',
  document: 'Document',
  link: 'Link',
};

export function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const fmtDateTime = (iso: string | null | undefined) => formatDateTime(iso);
