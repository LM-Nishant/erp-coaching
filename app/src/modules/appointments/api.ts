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
  SlotMode,
} from '@erp/shared';
import { api } from '@/core/api';
import { formatDate, formatDateTime, formatTime } from '@/core/format';
import { intlLocale } from '@/i18n';

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

export type Tone = 'success' | 'warning' | 'danger' | 'primary' | 'medium';

export const STATUS_TONES: Record<AppointmentStatus, Tone> = {
  requested: 'warning',
  confirmed: 'success',
  rejected: 'danger',
  cancelled: 'medium',
  completed: 'primary',
  no_show: 'danger',
};

/** i18n key of each status's label. */
export const STATUS_LABEL_KEYS: Record<AppointmentStatus, string> = {
  requested: 'appointments.status.requested',
  confirmed: 'common.status.confirmed',
  rejected: 'common.status.rejected',
  cancelled: 'common.status.cancelled',
  completed: 'common.status.completed',
  no_show: 'appointments.status.noShow',
};

/** i18n key of a history entry, e.g. `no_show` → `appointments.action.noShow`. */
export const actionKey = (action: string) =>
  `appointments.action.${action.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;

export const modeKey = (mode: SlotMode) => `appointments.mode.${mode}`;

/** Day name in the current language, 0 = Sunday. */
export const weekdayName = (day: number) =>
  new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', timeZone: 'UTC' }).format(
    Date.UTC(2023, 0, 1 + day),
  );

/** `HH:mm` on a `YYYY-MM-DD` day → `4:00 pm`. */
export const slotTime = (time: string, date = todayIso()) => formatTime(`${date}T${time}`);
export const slotTimeRange = (date: string, start: string, end: string) =>
  `${slotTime(start, date)}–${slotTime(end, date)}`;
/** `25 Nov 2026 · 4:00 pm–4:15 pm` */
export const meetingWhen = (m: { date: string; startTime: string; endTime: string }) =>
  `${formatDate(m.date)} · ${slotTimeRange(m.date, m.startTime, m.endTime)}`;
/** `25 Nov 2026, 4:00 pm` */
export const slotStart = (date: string, time: string) => formatDateTime(`${date}T${time}`);

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const addDaysIso = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
