import type {
  AppointmentDetailDto,
  AppointmentDto,
  AppointmentMode,
  AppointmentReportSummary,
  AppointmentSlotDto,
  AppointmentSlotInput,
  AppointmentStatus,
  AppointmentTeacherDto,
  AvailableSlotDto,
  Paginated,
  RequestAppointmentInput,
} from '@erp/shared';
import { api } from '@/core/api';

export interface AppointmentFilters {
  page?: number;
  pageSize?: number;
  status?: AppointmentStatus | '';
  from?: string;
  to?: string;
  studentId?: number;
  upcoming?: boolean;
  branchId?: number | null;
}

export interface ReportFilters {
  from?: string;
  to?: string;
  branchId?: number | null;
}

const base = '/appointments';

export const appointmentsApi = {
  slots: (q: { teacherUserId?: number; includeInactive?: boolean } = {}) =>
    api.get<AppointmentSlotDto[]>(`${base}/slots`, { ...q }),
  createSlot: (b: AppointmentSlotInput) => api.post<AppointmentSlotDto>(`${base}/slots`, b),
  updateSlot: (id: number, b: Partial<AppointmentSlotInput>) =>
    api.patch<AppointmentSlotDto>(`${base}/slots/${id}`, b),
  deleteSlot: (id: number) => api.delete(`${base}/slots/${id}`),

  teachersFor: (studentId: number) =>
    api.get<AppointmentTeacherDto[]>(`${base}/children/${studentId}/teachers`),
  availability: (teacherUserId: number, q: { studentId?: number; from: string; to: string }) =>
    api.get<AvailableSlotDto[]>(`${base}/teachers/${teacherUserId}/availability`, { ...q }),
  request: (b: RequestAppointmentInput) => api.post<AppointmentDto>(base, b),

  mine: (f: AppointmentFilters = {}) => api.get<Paginated<AppointmentDto>>(base, { ...f }),
  all: (f: AppointmentFilters = {}) => api.get<Paginated<AppointmentDto>>(`${base}/all`, { ...f }),
  get: (id: number) => api.get<AppointmentDetailDto>(`${base}/${id}`),

  approve: (id: number, b: { note?: string | null; location?: string | null; meetingUrl?: string | null }) =>
    api.post<AppointmentDto>(`${base}/${id}/approve`, b),
  reject: (id: number, reason: string) => api.post<AppointmentDto>(`${base}/${id}/reject`, { reason }),
  cancel: (id: number, reason: string) => api.post<AppointmentDto>(`${base}/${id}/cancel`, { reason }),
  reschedule: (
    id: number,
    b: { date: string; startTime: string; endTime?: string; mode?: AppointmentMode; reason?: string | null },
  ) => api.post<AppointmentDto>(`${base}/${id}/reschedule`, b),
  complete: (
    id: number,
    b: { outcome: 'completed' | 'no_show'; sharedSummary?: string | null; privateNotes?: string | null },
  ) => api.post<AppointmentDto>(`${base}/${id}/complete`, b),
  notes: (id: number, b: { sharedSummary?: string | null; privateNotes?: string | null }) =>
    api.patch<AppointmentDto>(`${base}/${id}/notes`, b),

  summary: (f: ReportFilters) => api.get<AppointmentReportSummary>(`${base}/reports/summary`, { ...f }),
  exportCsv: (f: ReportFilters) => api.get<string>(`${base}/reports/export.csv`, { ...f }),
};

export const STATUS_COLORS: Record<AppointmentStatus, string> = {
  requested: 'warning',
  confirmed: 'success',
  rejected: 'danger',
  cancelled: 'medium',
  completed: 'primary',
  no_show: 'dark',
};

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const addDaysIso = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
