import type {
  AssetStatus,
  EmployeeDto,
  LeaveApplicationDto,
  LeaveBalanceDto,
  LeaveTypeDto,
  SeparationStatus,
  SeparationType,
  StaffAttendanceDto,
  StaffAttendanceStatus,
} from '@erp/shared';
import { api } from '@/core/api';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface Candidate {
  id: number;
  name: string;
  mobile: string | null;
  email: string | null;
  roles: string[];
}
export interface Shift {
  id: number;
  branchId: number | null;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  weeklyOffs: number[] | null;
  active: boolean;
}
export interface EmployeeDocument {
  id: number;
  docType: string;
  title: string | null;
  createdAt: string;
  file: { originalName: string; url: string } | null;
}
export interface AttendanceSummaryRow {
  employee: { id: number; name: string; employeeCode: string };
  present: number;
  absent: number;
  late: number;
  leave: number;
  half_day: number;
  lopDays: number;
}
export interface Asset {
  id: number;
  employeeId: number;
  name: string;
  assetTag: string | null;
  issuedOn: string;
  returnedOn: string | null;
  valuePaise: number;
  status: AssetStatus;
  notes: string | null;
}
export interface Separation {
  id: number;
  employeeId: number;
  type: SeparationType;
  submittedOn: string;
  lastWorkingDay: string;
  noticePeriodDays: number;
  reason: string | null;
  status: SeparationStatus;
  employee?: { id: number; name: string; employeeCode: string };
}
export type ChildKind = 'qualifications' | 'experiences' | 'assignments' | 'contracts';
export type Row = Record<string, unknown> & { id: number };

export const hrApi = {
  employees: (q: { page?: number; pageSize?: number; search?: string; status?: string } = {}) =>
    api.get<Page<EmployeeDto>>('/hr/employees', { pageSize: 50, ...q }),
  employee: (id: number) => api.get<EmployeeDto>(`/hr/employees/${id}`),
  candidates: (search?: string) => api.get<Candidate[]>('/hr/employees/candidates', { search }),
  createEmployee: (b: Partial<EmployeeDto>) => api.post<EmployeeDto>('/hr/employees', b),
  updateEmployee: (id: number, b: Partial<EmployeeDto>) => api.patch<EmployeeDto>(`/hr/employees/${id}`, b),
  removeEmployee: (id: number) => api.delete(`/hr/employees/${id}`),
  children: (id: number, kind: ChildKind) => api.get<Row[]>(`/hr/employees/${id}/${kind}`),
  addChild: (id: number, kind: ChildKind, b: Record<string, unknown>) =>
    api.post<Row>(`/hr/employees/${id}/${kind}`, b),
  removeChild: (id: number, kind: ChildKind, childId: number) =>
    api.delete(`/hr/employees/${id}/${kind}/${childId}`),
  documents: (id: number) => api.get<EmployeeDocument[]>(`/hr/employees/${id}/documents`),
  uploadDocument: (id: number, file: File, docType: string) => {
    const form = new FormData();
    form.append('docType', docType);
    form.append('file', file, file.name);
    return api.post<EmployeeDocument>(`/hr/employees/${id}/documents`, form);
  },
  removeDocument: (id: number, docId: number) => api.delete(`/hr/employees/${id}/documents/${docId}`),
  balances: (id: number) => api.get<LeaveBalanceDto[]>(`/hr/employees/${id}/leave-balances`),

  shifts: () => api.get<Shift[]>('/hr/shifts'),
  saveShift: (b: Partial<Shift>, id?: number) =>
    id ? api.patch<Shift>(`/hr/shifts/${id}`, b) : api.post<Shift>('/hr/shifts', b),
  removeShift: (id: number) => api.delete(`/hr/shifts/${id}`),
  leaveTypes: () => api.get<LeaveTypeDto[]>('/hr/leave-types'),
  saveLeaveType: (b: Partial<LeaveTypeDto>, id?: number) =>
    id ? api.patch<LeaveTypeDto>(`/hr/leave-types/${id}`, b) : api.post<LeaveTypeDto>('/hr/leave-types', b),

  attendance: (from: string, to: string) => api.get<StaffAttendanceDto[]>('/hr/attendance', { from, to }),
  saveAttendance: (entries: { employeeId: number; date: string; status: StaffAttendanceStatus }[]) =>
    api.put<StaffAttendanceDto[]>('/hr/attendance', { entries }),
  attendanceSummary: (year: number, month: number) =>
    api.get<AttendanceSummaryRow[]>('/hr/attendance/summary', { year, month }),

  leaves: (q: { status?: string; page?: number } = {}) =>
    api.get<Page<LeaveApplicationDto>>('/hr/leaves', { pageSize: 50, ...q }),
  decideLeave: (id: number, approve: boolean, note?: string) =>
    api.post<LeaveApplicationDto>(`/hr/leaves/${id}/decision`, { approve, note: note || null }),
  cancelLeave: (id: number) => api.post<LeaveApplicationDto>(`/hr/leaves/${id}/cancel`),

  assets: () => api.get<Asset[]>('/hr/assets'),
  saveAsset: (b: Partial<Asset>, id?: number) =>
    id ? api.patch<Asset>(`/hr/assets/${id}`, b) : api.post<Asset>('/hr/assets', b),
  separations: () => api.get<Separation[]>('/hr/separations'),
  createSeparation: (b: Partial<Separation>) => api.post<Separation>('/hr/separations', b),
  transitionSeparation: (
    id: number,
    t: 'accept' | 'reject' | 'withdraw' | 'complete',
    lastWorkingDay?: string,
  ) => api.post<Separation>(`/hr/separations/${id}/${t}`, { lastWorkingDay }),

  me: () => api.get<EmployeeDto>('/hr/me'),
  myBalances: () => api.get<LeaveBalanceDto[]>('/hr/me/leave-balances'),
  myLeaveTypes: () => api.get<LeaveTypeDto[]>('/hr/me/leave-types'),
  myLeaves: () => api.get<LeaveApplicationDto[]>('/hr/me/leaves'),
  applyLeave: (b: {
    leaveTypeId: number;
    fromDate: string;
    toDate: string;
    halfDay?: boolean;
    reason?: string;
  }) => api.post<LeaveApplicationDto>('/hr/me/leaves', b),
  cancelMyLeave: (id: number) => api.post<LeaveApplicationDto>(`/hr/me/leaves/${id}/cancel`),
  myAttendance: (year: number, month: number) =>
    api.get<StaffAttendanceDto[]>('/hr/me/attendance', { year, month }),
  resign: (b: { lastWorkingDay?: string; reason?: string }) => api.post<Separation>('/hr/me/resignation', b),
};

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
