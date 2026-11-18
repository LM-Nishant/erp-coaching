import type {
  AiAdminUsageDto,
  AiSettingsDto,
  AiSettingsUpdate,
  AiTestResult,
  InstituteStatus,
  Paginated,
  PlanLimits,
} from '@erp/shared';
import { api } from '@/core/api';

export interface PlanDto {
  id: number;
  code: string;
  name: string;
  description: string | null;
  priceMonthlyPaise: number;
  priceYearlyPaise: number;
  trialDays: number;
  limits: PlanLimits;
  isActive: boolean;
  activeSubscriptions?: number;
}
export type PlanInput = Omit<PlanDto, 'id' | 'activeSubscriptions'>;

export interface InstituteRow {
  id: number;
  slug: string;
  name: string;
  status: InstituteStatus;
  city: string | null;
  contactPhone: string | null;
  branding: { logoUrl: string | null; primaryColor: string | null };
  subscription: { status: string; plan: { id: number; name: string } } | null;
}

export interface CreateInstituteInput {
  name: string;
  slug: string;
  planId: number;
  city?: string | null;
  primaryColor?: string | null;
  admin: { name: string; mobile: string; email?: string; password?: string };
}

export interface AuditEventRow {
  id: number;
  action: string;
  entityType: string | null;
  entityId: string | null;
  instituteId: number | null;
  actorUserId: number | null;
  impersonatorUserId: number | null;
  ip: string | null;
  metadata: unknown;
  createdAt: string;
}

export const adminApi = {
  institutes: (q: { page?: number; search?: string; status?: string }) =>
    api.get<Paginated<InstituteRow>>('/admin/institutes', q),
  createInstitute: (b: CreateInstituteInput) => api.post('/admin/institutes', b),
  setStatus: (id: number, status: InstituteStatus, reason?: string) =>
    api.post(`/admin/institutes/${id}/status`, { status, reason }),
  admins: (id: number) =>
    api.get<{ id: number; name: string; mobile: string }[]>(`/admin/institutes/${id}/admins`),
  changePlan: (id: number, planId: number) =>
    api.post(`/admin/institutes/${id}/subscriptions`, { planId, status: 'active' }),
  plans: () => api.get<PlanDto[]>('/admin/plans'),
  createPlan: (p: PlanInput) => api.post<PlanDto>('/admin/plans', p),
  updatePlan: (id: number, p: PlanInput) => api.put<PlanDto>(`/admin/plans/${id}`, p),
  aiSettings: () => api.get<AiSettingsDto>('/admin/ai/settings'),
  saveAiSettings: (b: AiSettingsUpdate) => api.put<AiSettingsDto>('/admin/ai/settings', b),
  removeAiKey: () => api.delete<AiSettingsDto>('/admin/ai/settings/key'),
  testAi: (b: Partial<AiSettingsUpdate>) => api.post<AiTestResult>('/admin/ai/settings/test', b),
  aiUsage: (days = 30) => api.get<AiAdminUsageDto>('/admin/ai/usage', { days }),
  audit: (q: { page?: number; action?: string }) =>
    api.get<Paginated<AuditEventRow>>('/admin/audit-events', q),
};
