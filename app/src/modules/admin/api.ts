import type {
  AiAdminUsageDto,
  AiSettingsDto,
  AiSettingsUpdate,
  AiTestResult,
  InstituteStatus,
  Paginated,
  PlatformUserDto,
  PlanDto,
} from '@erp/shared';
import { api } from '@/core/api';
import { i18n } from '@/i18n';

/** Translated institute, subscription or user status (`past_due` → `Past due`); unknown codes are humanized. */
export function statusLabel(status: string): string {
  const key = `admin.status.${status}`;
  if (i18n.global.te(key, 'en')) return i18n.global.t(key);
  const s = status.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type { PlanDto };
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

/** `GET /admin/institutes/:id` (profile fields used by the edit form). */
export interface InstituteDetail {
  id: number;
  slug: string;
  name: string;
  status: InstituteStatus;
  address: string | null;
  city: string | null;
  state: string | null;
  registrationNumber: string | null;
  gstin: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
}
export type InstituteProfileInput = Partial<Omit<InstituteDetail, 'id' | 'slug' | 'status'>>;

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
  institute: (id: number) => api.get<InstituteDetail>(`/admin/institutes/${id}`),
  updateInstitute: (id: number, b: InstituteProfileInput) =>
    api.patch<InstituteDetail>(`/admin/institutes/${id}`, b),
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
  /** Users matching a name, mobile or email (3+ characters); devices via `/admin/users/:id/devices`. */
  users: (search: string) => api.get<PlatformUserDto[]>('/admin/users', { search }),
  aiUsage: (days = 30) => api.get<AiAdminUsageDto>('/admin/ai/usage', { days }),
  audit: (q: { page?: number; action?: string }) =>
    api.get<Paginated<AuditEventRow>>('/admin/audit-events', q),
};
