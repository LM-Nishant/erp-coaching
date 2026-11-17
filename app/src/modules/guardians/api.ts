import type { ChildSummaryDto, GuardianDto, StudentProfileDto } from '@erp/shared';
import { api } from '@/core/api';
import type { Page } from '@/modules/students/api';

export const guardiansApi = {
  list: (q: { page?: number; search?: string; status?: 'active' | 'pending' | 'revoked' }) =>
    api.get<Page<GuardianDto>>('/guardians', { ...q }),
  get: (id: number) => api.get<GuardianDto>(`/guardians/${id}`),
  update: (
    id: number,
    b: { name?: string; email?: string | null; occupation?: string | null; address?: string | null },
  ) => api.patch<Partial<GuardianDto>>(`/guardians/${id}`, b),
};

export const guardianPortalApi = {
  children: () => api.get<ChildSummaryDto[]>('/guardian-portal/children'),
  child: (studentId: number) => api.get<StudentProfileDto>(`/guardian-portal/children/${studentId}`),
};
