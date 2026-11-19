import type {
  ReportCatalogItemDto,
  ReportExportDto,
  ReportExportFormat,
  ReportFilterOptionsDto,
  ReportFiltersInput,
  ReportKey,
  ReportResultDto,
  RoleDashboardDto,
  SaasDashboardDto,
} from '@erp/shared';
import { api } from '@/core/api';
import { saveFile } from '@/core/downloads';

export type PeriodInput = Pick<ReportFiltersInput, 'preset' | 'from' | 'to'>;

export const reportsApi = {
  catalog: () => api.get<ReportCatalogItemDto[]>('/reports/catalog'),
  filterOptions: () => api.get<ReportFilterOptionsDto>('/reports/filters'),
  dashboard: (f: ReportFiltersInput = {}) => api.get<RoleDashboardDto>('/reports/dashboard', { ...f }),
  report: (key: ReportKey, f: ReportFiltersInput = {}) =>
    api.get<ReportResultDto>(`/reports/${key}`, { ...f }),
  /** `ready` = download now; `queued` = runs as a background job and the user is notified when ready. */
  createExport: (key: ReportKey, format: ReportExportFormat, f: ReportFiltersInput = {}) =>
    api.post<ReportExportDto>(`/reports/${key}/exports`, { ...f, format }),
  exports: () => api.get<ReportExportDto[]>('/reports/exports'),
  getExport: (id: number) => api.get<ReportExportDto>(`/reports/exports/${id}`),
  /** The export file as an attachment; every download is audited. */
  downloadExport: (id: number) => api.download(`/reports/exports/${id}/download`),

  saasDashboard: (f: PeriodInput = {}) => api.get<SaasDashboardDto>('/admin/reports/dashboard', { ...f }),
  saasExport: (format: ReportExportFormat, f: PeriodInput = {}) =>
    api.download('/admin/reports/institutes/export', { ...f, format }),
};

/**
 * Downloads a ready export and saves it like other files. Returns a toast message for a browser download, or null on
 * a device, where the share sheet already showed the file.
 */
export async function saveExport(exp: Pick<ReportExportDto, 'id' | 'fileName'>): Promise<string | null> {
  const file = await reportsApi.downloadExport(exp.id);
  const name = exp.fileName ?? file.fileName ?? 'report-export';
  return (await saveFile(file.blob, name)) === 'downloaded' ? `Downloaded ${name}` : null;
}
