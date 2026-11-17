import type {
  PayType,
  PayrollComponentDto,
  PayrollRunDto,
  PayslipDto,
  PayslipLine,
  SettlementStatus,
  StructureItem,
  WorkUnitType,
} from '@erp/shared';
import { API_URL, ApiError, api } from '@/core/api';
import { loadSession } from '@/core/token-storage';
import type { Page } from '../hr/api';

export interface SalaryStructure {
  id: number;
  employeeId: number;
  payType: PayType;
  monthlyBasic: number;
  ratePerUnit: number;
  allowances: StructureItem[] | null;
  deductions: StructureItem[] | null;
  pfApplicable: boolean;
  esiApplicable: boolean;
  ptApplicable: boolean;
  tdsApplicable: boolean;
  tdsPercent: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  employee?: { id: number; name: string; employeeCode: string };
}
export interface WorkUnit {
  id: number;
  employeeId: number;
  date: string;
  unitType: WorkUnitType;
  quantity: number;
  amount: number;
  description: string | null;
  payrollRunId: number | null;
  externalRef: string | null;
  employee?: { id: number; name: string; employeeCode: string };
}
export interface Settlement {
  id: number;
  employeeId: number;
  separationId: number;
  lastWorkingDay: string;
  lines: PayslipLine[];
  net: number;
  status: SettlementStatus;
  notes: string | null;
  employee?: { id: number; name: string; employeeCode: string };
}
export interface ReportTable {
  headers: string[];
  rows: (string | number | null)[][];
}
export type ReportKind = 'register' | 'statutory' | 'annual';
export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export const payrollApi = {
  components: () => api.get<PayrollComponentDto[]>('/payroll/components'),
  saveComponent: (b: Partial<PayrollComponentDto>, id?: number) =>
    id
      ? api.patch<PayrollComponentDto>(`/payroll/components/${id}`, b)
      : api.post<PayrollComponentDto>('/payroll/components', b),
  removeComponent: (id: number) => api.delete(`/payroll/components/${id}`),

  structures: (current = true) => api.get<SalaryStructure[]>('/payroll/structures', { current }),
  createStructure: (b: Partial<SalaryStructure>) => api.post<SalaryStructure>('/payroll/structures', b),
  removeStructure: (id: number) => api.delete(`/payroll/structures/${id}`),

  workUnits: (year: number, month: number) => api.get<WorkUnit[]>('/payroll/work-units', { year, month }),
  addWorkUnit: (b: Partial<WorkUnit>) => api.post<WorkUnit>('/payroll/work-units', b),
  removeWorkUnit: (id: number) => api.delete(`/payroll/work-units/${id}`),

  runs: () => api.get<Page<PayrollRunDto>>('/payroll/runs', { pageSize: 100 }),
  createRun: (periodYear: number, periodMonth: number) =>
    api.post<PayrollRunDto>('/payroll/runs', { periodYear, periodMonth }),
  run: (id: number) => api.get<{ run: PayrollRunDto; payslips: PayslipDto[] }>(`/payroll/runs/${id}`),
  generate: (id: number) =>
    api.post<{ generated: number; skipped: { employeeId: number; name: string; reason: string }[] }>(
      `/payroll/runs/${id}/generate`,
    ),
  transition: (id: number, action: 'approve' | 'reopen' | 'lock') =>
    api.post<PayrollRunDto>(`/payroll/runs/${id}/${action}`),
  removeRun: (id: number) => api.delete(`/payroll/runs/${id}`),
  payslipPdf: (id: number) => api.get<SignedUrl>(`/payroll/payslips/${id}/pdf`),

  settlements: () => api.get<Settlement[]>('/payroll/settlements'),
  computeSettlement: (separationId: number, waiveNoticeRecovery = false) =>
    api.post<Settlement>('/payroll/settlements', { separationId, waiveNoticeRecovery }),
  transitionSettlement: (id: number, action: 'approve' | 'pay') =>
    api.post<Settlement>(`/payroll/settlements/${id}/${action}`),

  report: (kind: ReportKind, query: Record<string, number>) =>
    api.get<ReportTable>(`/payroll/reports/${kind}`, { ...query, format: 'json' }),

  myPayslips: () => api.get<PayslipDto[]>('/payroll/me/payslips'),
  myPayslipPdf: (id: number) => api.get<SignedUrl>(`/payroll/me/payslips/${id}/pdf`),
};

/** Downloads a CSV/Excel export with the session's auth headers and saves it via a Blob link. */
export async function downloadReport(kind: ReportKind, query: Record<string, number>, format: 'csv' | 'xls') {
  const session = await loadSession();
  const url = new URL(`${API_URL}/api/payroll/reports/${kind}`);
  Object.entries({ ...query, format }).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const headers: Record<string, string> = {};
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  if (session?.branchId) headers['X-Branch-Id'] = String(session.branchId);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new ApiError(res.status, 'HTTP_ERROR', `Export failed (${res.status})`);
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${kind}.${format}`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await res.blob());
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export const openSigned = (s: SignedUrl) => window.open(s.url, '_blank');
export const PAY_TYPE_LABELS: Record<PayType, string> = {
  fixed_monthly: 'Fixed monthly',
  per_lecture: 'Per lecture',
  per_class: 'Per class',
};
