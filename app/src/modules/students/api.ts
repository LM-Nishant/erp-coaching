import { formatDate, formatDateTime } from '@/core/format';
import type {
  AcademicInfo,
  AcademicRecordDto,
  DuplicateMatch,
  GuardianRelation,
  SelfRegistrationInfo,
  SelfRegistrationInput,
  SelfRegistrationResult,
  StudentDocumentDto,
  StudentDto,
  StudentGuardianDto,
  StudentProfileDto,
  StudentSettings,
  StudentStatus,
} from '@erp/shared';
import { api } from '@/core/api';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StudentInput {
  name: string;
  mobile: string;
  email?: string | null;
  branchId?: number;
  dateOfBirth?: string | null;
  gender?: 'male' | 'female' | 'other' | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  idType?: string | null;
  idNumber?: string | null;
  academicInfo?: AcademicInfo | null;
  customFields?: Record<string, unknown> | null;
}

export interface GuardianInput {
  name: string;
  mobile: string;
  email?: string | null;
  relation: GuardianRelation;
  isPrimary?: boolean;
  occupation?: string | null;
}

export interface AcademicRecordInput {
  academicYear?: string | null;
  institution?: string | null;
  classGrade?: string | null;
  board?: string | null;
  result?: string | null;
  percentage?: number | null;
  remarks?: string | null;
}

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: StudentStatus;
  branchId?: number;
}

function documentForm(file: File, docType: string, title?: string) {
  const form = new FormData();
  form.append('docType', docType);
  if (title) form.append('title', title);
  form.append('file', file, file.name);
  return form;
}

export const studentsApi = {
  list: (q: ListQuery = {}) => api.get<Page<StudentDto>>('/students', { ...q }),
  get: (id: number) => api.get<StudentProfileDto>(`/students/${id}`),
  create: (b: StudentInput & { allowDuplicate?: boolean; password?: string }) =>
    api.post<StudentDto>('/students', b),
  update: (id: number, b: Partial<StudentInput>) => api.patch<StudentDto>(`/students/${id}`, b),
  remove: (id: number) => api.delete(`/students/${id}`),
  setStatus: (id: number, status: StudentStatus, reason?: string | null) =>
    api.patch<StudentDto>(`/students/${id}/status`, { status, reason }),
  transfer: (id: number, b: { branchId: number; reason?: string | null; regenerateRollNumber?: boolean }) =>
    api.post<StudentDto>(`/students/${id}/transfer`, b),
  duplicates: (q: { mobile?: string; email?: string; idNumber?: string; excludeStudentId?: number }) =>
    api.get<DuplicateMatch[]>('/students/duplicates', q),
  addRecord: (id: number, b: AcademicRecordInput) =>
    api.post<AcademicRecordDto>(`/students/${id}/academic-records`, b),
  removeRecord: (id: number, recordId: number) => api.delete(`/students/${id}/academic-records/${recordId}`),
  uploadDocument: (id: number, file: File, docType: string, title?: string) =>
    api.post<StudentDocumentDto>(`/students/${id}/documents`, documentForm(file, docType, title)),
  removeDocument: (id: number, documentId: number) => api.delete(`/students/${id}/documents/${documentId}`),
  settings: () => api.get<StudentSettings>('/students/settings'),
  saveSettings: (b: Partial<StudentSettings>) => api.put<StudentSettings>('/students/settings', b),

  guardians: (id: number) => api.get<StudentGuardianDto[]>(`/students/${id}/guardians`),
  linkGuardian: (id: number, b: GuardianInput) =>
    api.post<StudentGuardianDto>(`/students/${id}/guardians`, b),
  updateLink: (
    id: number,
    linkId: number,
    b: { status?: 'active' | 'pending' | 'revoked'; relation?: GuardianRelation; isPrimary?: boolean },
  ) => api.patch<StudentGuardianDto>(`/students/${id}/guardians/${linkId}`, b),
  unlink: (id: number, linkId: number) => api.delete(`/students/${id}/guardians/${linkId}`),
};

export const studentPortalApi = {
  me: () => api.get<StudentProfileDto>('/student-portal/me'),
  update: (b: Partial<StudentInput>) => api.patch<StudentDto>('/student-portal/me', b),
  uploadDocument: (file: File, docType: string, title?: string) =>
    api.post<StudentDocumentDto>('/student-portal/me/documents', documentForm(file, docType, title)),
};

export const registrationApi = {
  info: (slug: string) =>
    api.get<SelfRegistrationInfo>(`/public/institutes/${encodeURIComponent(slug)}/registration`, undefined, {
      anonymous: true,
    }),
  register: (slug: string, b: SelfRegistrationInput) =>
    api.post<SelfRegistrationResult>(`/public/institutes/${encodeURIComponent(slug)}/register`, b, {
      anonymous: true,
    }),
};

export const STATUS_COLORS: Record<StudentStatus, string> = {
  active: 'success',
  suspended: 'warning',
  discontinued: 'danger',
  inactive: 'medium',
};

export const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const DOCUMENT_TYPES = ['photo', 'id_proof', 'address_proof', 'marksheet', 'certificate', 'other'];

/** `27 Nov 2026` (or `27 Nov 2026, 9:00 pm`) in the user's language; empty when there is no date. */
export function fmtDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return '';
  return withTime ? formatDateTime(iso) : formatDate(iso);
}
