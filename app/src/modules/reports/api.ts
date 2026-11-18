import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type {
  ReportCatalogItemDto,
  ReportDownloadDto,
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
  /** Short-lived signed link; every call is audited. */
  downloadLink: (id: number) => api.post<ReportDownloadDto>(`/reports/exports/${id}/download`),

  saasDashboard: (f: PeriodInput = {}) => api.get<SaasDashboardDto>('/admin/reports/dashboard', { ...f }),
  saasExport: (format: ReportExportFormat, f: PeriodInput = {}) =>
    api.download('/admin/reports/institutes/export', { ...f, format }),
};

/** Opens a ready export through a fresh signed link (the browser or the OS handles the file). */
export async function openExport(id: number) {
  const link = await reportsApi.downloadLink(id);
  window.open(link.url, '_blank');
}

/** Saves a downloaded file: a browser download on the web, the Documents folder on devices. */
export async function saveFile(blob: Blob, fileName: string): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    const data = await blobToBase64(blob);
    const { uri } = await Filesystem.writeFile({ path: fileName, data, directory: Directory.Documents });
    return uri;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(blob);
  });
}
