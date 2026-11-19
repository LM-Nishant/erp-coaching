import type {
  DataExportDto,
  DataExportLinkDto,
  DataExportStatus,
  DeletionRequestDto,
  DeletionRequestStatus,
  Paginated,
} from '@erp/shared';
import { api } from '@/core/api';

export interface DeletionInput {
  /** The institute code (slug), repeated to confirm. */
  confirm: string;
  reason?: string | null;
}

/** Export and deletion endpoints of one institute: the signed-in one, or any institute for the super admin. */
export interface TenantDataScope {
  exports(): Promise<DataExportDto[]>;
  requestExport(includeMedia: boolean): Promise<DataExportDto>;
  exportLink(id: number): Promise<DataExportLinkDto>;
  deleteExport(id: number): Promise<void>;
  deletionRequest(): Promise<DeletionRequestDto | null>;
  requestDeletion(b: DeletionInput): Promise<DeletionRequestDto>;
}

function scopeAt(base: string): TenantDataScope {
  return {
    exports: () => api.get<DataExportDto[]>(`${base}/exports`),
    requestExport: (includeMedia) => api.post<DataExportDto>(`${base}/exports`, { includeMedia }),
    exportLink: (id) => api.post<DataExportLinkDto>(`${base}/exports/${id}/link`),
    deleteExport: (id) => api.delete(`${base}/exports/${id}`),
    deletionRequest: async () =>
      (await api.get<{ request: DeletionRequestDto | null }>(`${base}/deletion-request`)).request,
    requestDeletion: (b) => api.post<DeletionRequestDto>(`${base}/deletion-request`, b),
  };
}

/** The signed-in institute (institute-wide administrators). */
export const ownInstitute = scopeAt('/tenant-data');
/** Any institute, for the super admin. */
export const instituteScope = (instituteId: number) =>
  scopeAt(`/admin/tenant-data/institutes/${instituteId}`);

/** The institute withdraws its own request while it awaits review. */
export const withdrawOwnDeletion = () => api.post<DeletionRequestDto>('/tenant-data/deletion-request/cancel');

const admin = '/admin/tenant-data/deletion-requests';

/** Super admin review of deletion requests. */
export const deletionAdminApi = {
  list: (q: { status?: DeletionRequestStatus; search?: string; page: number; pageSize: number }) =>
    api.get<Paginated<DeletionRequestDto>>(admin, { ...q }),
  approve: (id: number, b: { graceDays: number; note?: string | null }) =>
    api.post<DeletionRequestDto>(`${admin}/${id}/approve`, b),
  reject: (id: number, b: { note?: string | null }) =>
    api.post<DeletionRequestDto>(`${admin}/${id}/reject`, b),
  cancel: (id: number, b: { note?: string | null }) =>
    api.post<DeletionRequestDto>(`${admin}/${id}/cancel`, b),
  retry: (id: number) => api.post<DeletionRequestDto>(`${admin}/${id}/retry`),
};

export const DEFAULT_GRACE_DAYS = 30;

export const EXPORT_STATUS_LABELS: Record<DataExportStatus, string> = {
  pending: 'Queued',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

export const EXPORT_STATUS_COLORS: Record<DataExportStatus, string> = {
  pending: 'medium',
  running: 'warning',
  ready: 'success',
  failed: 'danger',
  expired: 'medium',
};

export const DELETION_STATUSES: DeletionRequestStatus[] = [
  'pending',
  'approved',
  'purging',
  'failed',
  'completed',
  'rejected',
  'cancelled',
];

export const DELETION_STATUS_LABELS: Record<DeletionRequestStatus, string> = {
  pending: 'Awaiting approval',
  approved: 'Scheduled',
  purging: 'Deleting',
  failed: 'Deletion failed',
  completed: 'Deleted',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const DELETION_STATUS_COLORS: Record<DeletionRequestStatus, string> = {
  pending: 'warning',
  approved: 'danger',
  purging: 'danger',
  failed: 'danger',
  completed: 'dark',
  rejected: 'medium',
  cancelled: 'medium',
};

export const exportInProgress = (x: Pick<DataExportDto, 'status'>) =>
  x.status === 'pending' || x.status === 'running';

/** A new deletion request can be raised when there is none, or the last one was rejected or cancelled. */
export const canRequestDeletion = (latest: Pick<DeletionRequestDto, 'status'> | null) =>
  !latest || latest.status === 'rejected' || latest.status === 'cancelled';

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export const formatWhen = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** One-line description of an export's contents. */
export function exportDetail(x: DataExportDto): string {
  const media = x.includeMedia ? 'with uploaded files' : 'records only';
  if (x.status === 'pending') return `Queued · ${media}`;
  if (x.status === 'running') return `Preparing · ${media}`;
  if (x.status === 'failed') return `Failed · ${media}`;
  const parts = [
    formatBytes(x.sizeBytes),
    x.tableCount !== null ? `${x.tableCount} tables` : '',
    x.rowCount !== null ? `${x.rowCount.toLocaleString('en-IN')} rows` : '',
    x.includeMedia && x.fileCount !== null ? `${x.fileCount.toLocaleString('en-IN')} files` : '',
  ].filter(Boolean);
  if (!x.includeMedia) parts.push(media);
  if (x.status === 'ready' && x.expiresAt) parts.push(`available until ${formatWhen(x.expiresAt)}`);
  if (x.status === 'expired') parts.push('archive removed');
  return parts.join(' · ');
}

/** Totals of a completed deletion. */
export function deletionTotals(r: Pick<DeletionRequestDto, 'summary'>): string {
  const s = r.summary;
  if (!s) return '';
  const counts = Object.values(s.tables);
  const rows = counts.reduce((a, b) => a + b, 0);
  const tables = counts.filter((n) => n > 0).length;
  return [
    `${rows.toLocaleString('en-IN')} rows from ${tables} tables`,
    `${s.files.toLocaleString('en-IN')} files`,
    `${s.users} user accounts deleted`,
    s.anonymizedUsers ? `${s.anonymizedUsers} anonymised` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
