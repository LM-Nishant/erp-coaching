import type {
  AdmissionFormDto,
  AdmissionFormPurpose,
  AdmitApplicationResultDto,
  ApplicationDto,
  ApplicationStatus,
  CourseBatchOptionDto,
  DuplicateMatch,
  EnquiryDto,
  EnquiryFollowUpDto,
  EnquiryStatus,
  FormFieldDef,
  StudentDto,
} from '@erp/shared';
import { api } from '@/core/api';
import type { Page } from '@/modules/students/api';

export interface EnquiryInput {
  name: string;
  mobile: string;
  email?: string | null;
  branchId?: number;
  source: string;
  counsellorUserId?: number | null;
  courseInterest?: string | null;
  courseId?: number | null;
  notes?: string | null;
  customFields?: Record<string, unknown> | null;
}

export interface ApplicationInput {
  name: string;
  mobile: string;
  email?: string | null;
  branchId?: number;
  enquiryId?: number | null;
  courseId?: number | null;
  batchId?: number | null;
  formId?: number | null;
  formData?: Record<string, unknown> | null;
  waitlist?: boolean;
}

/** Changes to an open application; a self-registered student's keeps their profile's name, mobile, email and branch. */
export type ApplicationPatch = Partial<Omit<ApplicationInput, 'enquiryId' | 'formId' | 'waitlist'>>;

export interface FormInput {
  name: string;
  description?: string | null;
  purpose: AdmissionFormPurpose;
  branchId?: number | null;
  fields: FormFieldDef[];
  isActive?: boolean;
}

export type EnquiryDetail = EnquiryDto & { followUps: EnquiryFollowUpDto[] };

export const admissionsApi = {
  enquiries: (q: {
    page?: number;
    search?: string;
    status?: EnquiryStatus;
    source?: string;
    mine?: boolean;
    followUpDue?: boolean;
  }) => api.get<Page<EnquiryDto>>('/admissions/enquiries', { ...q }),
  summary: () => api.get<Record<EnquiryStatus, number>>('/admissions/enquiries/summary'),
  enquiry: (id: number) => api.get<EnquiryDetail>(`/admissions/enquiries/${id}`),
  createEnquiry: (b: EnquiryInput) =>
    api.post<EnquiryDto & { duplicates: DuplicateMatch[] }>('/admissions/enquiries', b),
  updateEnquiry: (id: number, b: Partial<EnquiryInput> & { status?: EnquiryStatus }) =>
    api.patch<EnquiryDto>(`/admissions/enquiries/${id}`, b),
  removeEnquiry: (id: number) => api.delete(`/admissions/enquiries/${id}`),
  addFollowUp: (
    id: number,
    b: { note?: string | null; outcome?: string | null; scheduledAt?: string | null; completed?: boolean },
  ) => api.post<EnquiryFollowUpDto>(`/admissions/enquiries/${id}/follow-ups`, b),
  completeFollowUp: (id: number, followUpId: number) =>
    api.patch<EnquiryFollowUpDto>(`/admissions/enquiries/${id}/follow-ups/${followUpId}`, {
      completed: true,
    }),
  convert: (id: number, b: { allowDuplicate?: boolean } = {}) =>
    api.post<StudentDto>(`/admissions/enquiries/${id}/convert`, b),
  toApplication: (e: EnquiryDto, waitlist = false) =>
    api.post<ApplicationDto>('/admissions/applications', {
      enquiryId: e.id,
      branchId: e.branchId,
      name: e.name,
      mobile: e.mobile,
      email: e.email,
      courseId: e.courseId,
      waitlist,
    }),

  applications: (q: { page?: number; search?: string; status?: ApplicationStatus }) =>
    api.get<Page<ApplicationDto>>('/admissions/applications', { ...q }),
  createApplication: (b: ApplicationInput) => api.post<ApplicationDto>('/admissions/applications', b),
  updateApplication: (id: number, b: ApplicationPatch) =>
    api.patch<ApplicationDto>(`/admissions/applications/${id}`, b),
  /** Open batches of the application's course, with free seats, it can be admitted into. */
  applicationBatches: (id: number) =>
    api.get<CourseBatchOptionDto[]>(`/admissions/applications/${id}/batches`),
  waitlist: (id: number) => api.post<ApplicationDto>(`/admissions/applications/${id}/waitlist`, {}),
  move: (id: number, position: number) =>
    api.post<ApplicationDto>(`/admissions/applications/${id}/move`, { position }),
  approve: (id: number, remarks?: string) =>
    api.post<ApplicationDto>(`/admissions/applications/${id}/approve`, { remarks }),
  reject: (id: number, remarks?: string) =>
    api.post<ApplicationDto>(`/admissions/applications/${id}/reject`, { remarks }),
  withdraw: (id: number, remarks?: string) =>
    api.post<ApplicationDto>(`/admissions/applications/${id}/withdraw`, { remarks }),
  /** `batchId` replaces the application's batch (null admits without one); omit it to keep the batch. */
  admit: (id: number, b: { allowDuplicate?: boolean; batchId?: number | null } = {}) =>
    api.post<AdmitApplicationResultDto>(`/admissions/applications/${id}/admit`, b),

  forms: () => api.get<AdmissionFormDto[]>('/admissions/forms'),
  form: (id: number) => api.get<AdmissionFormDto>(`/admissions/forms/${id}`),
  activeForm: (purpose: AdmissionFormPurpose, branchId?: number) =>
    api.get<AdmissionFormDto | null>('/admissions/forms/active', { purpose, branchId }),
  createForm: (b: FormInput) => api.post<AdmissionFormDto>('/admissions/forms', b),
  updateForm: (id: number, b: FormInput) => api.put<AdmissionFormDto>(`/admissions/forms/${id}`, b),
  removeForm: (id: number) => api.delete(`/admissions/forms/${id}`),
};

export const ENQUIRY_COLORS: Record<EnquiryStatus, string> = {
  new: 'primary',
  contacted: 'tertiary',
  follow_up: 'warning',
  interested: 'secondary',
  not_interested: 'medium',
  converted: 'success',
  lost: 'danger',
};

export const APPLICATION_COLORS: Record<ApplicationStatus, string> = {
  pending: 'primary',
  waitlisted: 'warning',
  approved: 'secondary',
  rejected: 'danger',
  admitted: 'success',
  withdrawn: 'medium',
};
