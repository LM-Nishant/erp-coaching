import type {
  CreateGrievanceInput,
  GrievanceActivityDto,
  GrievanceAttachmentDto,
  GrievanceCategoryDto,
  GrievanceCategoryInput,
  GrievancePriority,
  GrievanceReportSummary,
  GrievanceSettingsDto,
  GrievanceStatus,
  GrievanceTicketDetailDto,
  GrievanceTicketDto,
  GrievanceUserRef,
  Paginated,
} from '@erp/shared';
import { api } from '@/core/api';

export interface TicketFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  priority?: GrievancePriority | '';
  categoryId?: number | null;
  assignee?: 'me' | 'unassigned' | number | '';
  overdue?: boolean;
}

export interface ReportFilters {
  from?: string;
  to?: string;
  categoryId?: number | null;
}

const base = '/grievances';

export const grievancesApi = {
  categories: (all = false) =>
    api.get<GrievanceCategoryDto[]>(`${base}/categories`, { all: all || undefined }),
  createCategory: (b: GrievanceCategoryInput) => api.post<GrievanceCategoryDto>(`${base}/categories`, b),
  updateCategory: (id: number, b: Partial<GrievanceCategoryInput>) =>
    api.patch<GrievanceCategoryDto>(`${base}/categories/${id}`, b),
  removeCategory: (id: number) => api.delete(`${base}/categories/${id}`),
  settings: () => api.get<GrievanceSettingsDto>(`${base}/settings`),
  saveSettings: (b: Partial<GrievanceSettingsDto>) => api.put<GrievanceSettingsDto>(`${base}/settings`, b),
  assignees: () => api.get<GrievanceUserRef[]>(`${base}/assignees`),
  linkedStudents: () => api.get<GrievanceUserRef[]>(`${base}/linked-students`),

  queue: (f: TicketFilters) => api.get<Paginated<GrievanceTicketDto>>(base, { ...f }),
  mine: (f: TicketFilters) => api.get<Paginated<GrievanceTicketDto>>(`${base}/mine`, { ...f }),
  create: (b: CreateGrievanceInput) => api.post<GrievanceTicketDto>(base, b),
  get: (id: number) => api.get<GrievanceTicketDetailDto>(`${base}/${id}`),
  update: (id: number, b: { priority?: GrievancePriority; categoryId?: number }) =>
    api.patch<GrievanceTicketDto>(`${base}/${id}`, b),
  assign: (id: number, assigneeUserId: number | null, note?: string) =>
    api.post<GrievanceTicketDto>(`${base}/${id}/assign`, { assigneeUserId, note }),
  setStatus: (id: number, b: { status: GrievanceStatus; note?: string; resolutionNotes?: string }) =>
    api.post<GrievanceTicketDto>(`${base}/${id}/status`, b),
  comment: (id: number, body: string, internal = false) =>
    api.post<GrievanceActivityDto>(`${base}/${id}/comments`, { body, internal }),
  reopen: (id: number, reason: string) => api.post<GrievanceTicketDto>(`${base}/${id}/reopen`, { reason }),
  confirmClosure: (id: number, b: { rating?: number; feedback?: string }) =>
    api.post<GrievanceTicketDto>(`${base}/${id}/confirm-closure`, b),
  attach: (id: number, file: File, opts: { internal?: boolean; commentId?: number } = {}) => {
    const form = new FormData();
    form.append('file', file, file.name);
    if (opts.internal) form.append('internal', 'true');
    if (opts.commentId) form.append('commentId', String(opts.commentId));
    return api.post<GrievanceAttachmentDto>(`${base}/${id}/attachments`, form);
  },
  attachmentUrl: (id: number, attachmentId: number) =>
    api.get<{ url: string; expiresAt: string }>(`${base}/${id}/attachments/${attachmentId}/url`),

  summary: (f: ReportFilters) => api.get<GrievanceReportSummary>(`${base}/reports/summary`, { ...f }),
  exportCsv: (f: ReportFilters) => api.get<string>(`${base}/reports/export.csv`, { ...f }),
};

export type Tone = 'success' | 'warning' | 'danger' | 'primary' | 'medium';

export const STATUS_TONES: Record<GrievanceStatus, Tone> = {
  open: 'primary',
  in_progress: 'warning',
  escalated: 'danger',
  resolved: 'success',
  closed: 'medium',
};

/** Ionic colours; still used by the parent-portal widget. */
export const STATUS_COLORS: Record<GrievanceStatus, string> = { ...STATUS_TONES, in_progress: 'tertiary' };

export const PRIORITY_TONES: Record<GrievancePriority, Tone> = {
  low: 'medium',
  medium: 'primary',
  high: 'warning',
  urgent: 'danger',
};

/** i18n key of each status's label. */
export const STATUS_LABEL_KEYS: Record<GrievanceStatus, string> = {
  open: 'common.status.open',
  in_progress: 'common.status.inProgress',
  escalated: 'grievances.status.escalated',
  resolved: 'common.status.resolved',
  closed: 'common.status.closed',
};

/** i18n key of the button that moves a ticket to each status. */
export const STATUS_ACTION_KEYS: Record<GrievanceStatus, string> = {
  open: 'grievances.statusAction.open',
  in_progress: 'grievances.statusAction.inProgress',
  escalated: 'grievances.statusAction.escalated',
  resolved: 'grievances.statusAction.resolved',
  closed: 'grievances.statusAction.closed',
};

export const statusKey = (s: string) => STATUS_LABEL_KEYS[s as GrievanceStatus] ?? s;
export const priorityKey = (p: string) => `grievances.priority.${p}`;
export const fileSizeKb = (bytes: number) => Math.ceil(bytes / 1024);
export const isOverdue = (t: GrievanceTicketDto) =>
  !!t.dueAt && ['open', 'in_progress'].includes(t.status) && new Date(t.dueAt) < new Date();
