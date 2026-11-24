import type {
  PayType,
  PayrollComponentDto,
  PayrollRunDto,
  PayrollRunStatus,
  PayslipDto,
  PayslipLine,
  SettlementStatus,
  StructureItem,
  WorkUnitType,
} from '@erp/shared';
import { api } from '@/core/api';
import { openFileLink, saveFile } from '@/core/downloads';
import type { Chip, Page } from '../hr/api';

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

/** Downloads a CSV/Excel export and saves it (a browser download, or the share sheet on a device). */
export async function downloadReport(kind: ReportKind, query: Record<string, number>, format: 'csv' | 'xls') {
  const file = await api.download(`/payroll/reports/${kind}`, { ...query, format });
  await saveFile(file.blob, file.fileName ?? `${kind}.${format}`);
}

export const openSigned = (s: SignedUrl) => openFileLink(s.url);

export const RUN_STATUS: Record<PayrollRunStatus, Chip> = {
  draft: { label: 'common.status.draft', tone: 'medium' },
  approved: { label: 'common.status.approved', tone: 'warning' },
  locked: { label: 'payroll.status.locked', tone: 'success' },
};
export const SETTLEMENT_STATUS: Record<SettlementStatus, Chip> = {
  draft: { label: 'common.status.draft', tone: 'medium' },
  approved: { label: 'common.status.approved', tone: 'warning' },
  paid: { label: 'common.status.paid', tone: 'success' },
};
