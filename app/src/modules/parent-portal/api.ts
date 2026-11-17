import type {
  ParentChildDto,
  ParentMonthlyReportDto,
  ParentPortalSectionDto,
  ParentTimetableDto,
} from '@erp/shared';
import { api } from '@/core/api';

const base = '/parent-portal';

export const parentPortalApi = {
  children: () => api.get<ParentChildDto[]>(`${base}/children`),
  timetable: (studentId: number, q: { from?: string; to?: string } = {}) =>
    api.get<ParentTimetableDto>(`${base}/children/${studentId}/timetable`, { ...q }),
  summary: (studentId: number) => api.get<ParentPortalSectionDto[]>(`${base}/children/${studentId}/summary`),
  monthlyReports: (studentId: number) =>
    api.get<ParentMonthlyReportDto[]>(`${base}/children/${studentId}/monthly-reports`),
};
