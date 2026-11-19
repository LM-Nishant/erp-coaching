import type {
  AttendanceCorrectionDto,
  AttendanceDayDto,
  AttendanceDeviceDto,
  AttendanceRosterDto,
  AttendanceSettingsDto,
  AttendanceStatus,
  BatchDto,
  CheckInOptionsDto,
  CheckInResult,
  DeviceCommandDto,
  DeviceEventDto,
  DeviceIngestResult,
  DevicePinDto,
  DevicePinUpdate,
  DeviceProtocol,
  GroupAttendanceReportRow,
  Paginated,
  QrTokenDto,
  StudentAttendanceReportRow,
  StudentAttendanceSummaryDto,
  StudentLeaveRequestDto,
} from '@erp/shared';
import { api, API_URL } from '@/core/api';

const A = '/attendance';

export interface BranchRef {
  id: number;
  name: string;
}

export type ReportKind = 'students' | 'batches' | 'branches';
export interface ReportFilters {
  from: string;
  to: string;
  batchId?: number | null;
  branchId?: number | null;
}
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface DeviceSettingsInput {
  name?: string;
  branchId?: number | null;
  /** ADMS devices only. */
  timeZone?: string | null;
  ipAllowlist?: string[];
  allowHttp?: boolean;
}

export type DeviceCommandInput =
  | { kind: 'sync_clock' | 'device_info' | 'fetch_users' }
  | { kind: 'fetch_user'; pin: string }
  | { kind: 'fetch_logs'; from: string; to: string };

/** What to enter on a ZKTeco/eSSL device: it calls `/iclock/*` on the API host, at the server root. */
export function admsServer() {
  const u = new URL(API_URL);
  const https = u.protocol === 'https:';
  return { host: u.hostname, port: u.port || (https ? '443' : '80'), https };
}

export const attendanceApi = {
  settings: () => api.get<AttendanceSettingsDto>(`${A}/settings`),
  saveSettings: (b: Partial<AttendanceSettingsDto>) => api.put<AttendanceSettingsDto>(`${A}/settings`, b),

  day: (date: string, batchId?: number) => api.get<AttendanceDayDto>(`${A}/day`, { date, batchId }),
  openSession: (b: { classSessionId?: number; batchId?: number; date?: string }) =>
    api.post<AttendanceRosterDto>(`${A}/sessions`, b),
  session: (id: number) => api.get<AttendanceRosterDto>(`${A}/sessions/${id}`),
  mark: (
    id: number,
    records: { studentUserId: number; status: AttendanceStatus; remarks?: string | null }[],
  ) => api.put<AttendanceRosterDto & { saved: number }>(`${A}/sessions/${id}/records`, { records }),
  close: (id: number) => api.post<AttendanceRosterDto>(`${A}/sessions/${id}/close`),
  reopen: (id: number) => api.post<Pick<AttendanceRosterDto, 'session'>>(`${A}/sessions/${id}/reopen`),
  qr: (id: number) => api.get<QrTokenDto>(`${A}/sessions/${id}/qr`),

  corrections: (status?: RequestStatus) =>
    api.get<Paginated<AttendanceCorrectionDto>>(`${A}/corrections`, { status, pageSize: 100 }),
  decideCorrection: (id: number, approve: boolean, note?: string) =>
    api.post<AttendanceCorrectionDto>(`${A}/corrections/${id}/decide`, { approve, note }),
  leaves: (status?: RequestStatus) =>
    api.get<Paginated<StudentLeaveRequestDto>>(`${A}/leaves`, { status, pageSize: 100 }),
  decideLeave: (id: number, approve: boolean, note?: string) =>
    api.post<StudentLeaveRequestDto & { convertedRecords?: number }>(`${A}/leaves/${id}/decide`, {
      approve,
      note,
    }),

  studentReport: (f: ReportFilters) =>
    api.get<StudentAttendanceReportRow[]>(`${A}/reports/students`, { ...f }),
  groupReport: (by: 'batches' | 'branches', f: ReportFilters) =>
    api.get<GroupAttendanceReportRow[]>(`${A}/reports/${by}`, { ...f }),
  /** CSV text or SpreadsheetML (opens in Excel). */
  exportReport: (kind: ReportKind, f: ReportFilters, format: 'csv' | 'xls') =>
    api.get<string>(`${A}/reports/${kind}`, { ...f, format }),
  studentSummary: (studentUserId: number, year?: number) =>
    api.get<StudentAttendanceSummaryDto>(`${A}/reports/students/${studentUserId}`, { year }),

  devices: () => api.get<AttendanceDeviceDto[]>(`${A}/devices`),
  createDevice: (b: DeviceSettingsInput & { name: string; serial: string; protocol?: DeviceProtocol }) =>
    api.post<AttendanceDeviceDto>(`${A}/devices`, b),
  updateDevice: (id: number, b: DeviceSettingsInput & { active?: boolean }) =>
    api.patch<AttendanceDeviceDto>(`${A}/devices/${id}`, b),
  rotateDeviceKey: (id: number) => api.post<AttendanceDeviceDto>(`${A}/devices/${id}/rotate-key`),
  removeDevice: (id: number) => api.delete(`${A}/devices/${id}`),
  deviceCommands: (id: number) => api.get<DeviceCommandDto[]>(`${A}/devices/${id}/commands`),
  sendDeviceCommand: (id: number, cmd: DeviceCommandInput) =>
    api.post<DeviceCommandDto>(`${A}/devices/${id}/commands`, cmd),
  importDeviceEvents: (id: number, payload: unknown) =>
    api.post<DeviceIngestResult>(`${A}/devices/${id}/events`, payload),
  deviceEvents: (status?: string) =>
    api.get<Paginated<DeviceEventDto>>(`${A}/device-events`, { status, pageSize: 50 }),
  devicePins: () => api.get<DevicePinDto[]>(`${A}/device-pins`),
  setDevicePin: (b: DevicePinUpdate) =>
    api.put<{ reapplied: DeviceIngestResult | null }>(`${A}/device-pins`, b),

  checkInOptions: () => api.get<CheckInOptionsDto>(`${A}/me/check-in-options`),
  checkIn: (b: {
    method: 'qr' | 'mobile';
    token?: string;
    classSessionId?: number;
    batchId?: number;
    lat?: number;
    lng?: number;
  }) => api.post<CheckInResult>(`${A}/check-in`, b),
  mySummary: (year?: number) => api.get<StudentAttendanceSummaryDto>(`${A}/me/summary`, { year }),
  children: () => api.get<{ studentUserId: number; name: string }[]>(`${A}/me/children`),
  childSummary: (studentUserId: number, year?: number) =>
    api.get<StudentAttendanceSummaryDto>(`${A}/me/children/${studentUserId}/summary`, { year }),
  myCorrections: () => api.get<AttendanceCorrectionDto[]>(`${A}/me/corrections`),
  requestCorrection: (b: {
    attendanceSessionId: number;
    studentUserId?: number;
    requestedStatus: AttendanceStatus;
    reason: string;
  }) => api.post<AttendanceCorrectionDto>(`${A}/me/corrections`, b),
  cancelCorrection: (id: number) => api.post<AttendanceCorrectionDto>(`${A}/me/corrections/${id}/cancel`),
  myLeaves: () => api.get<StudentLeaveRequestDto[]>(`${A}/me/leaves`),
  requestLeave: (b: { studentUserId?: number; fromDate: string; toDate: string; reason: string }) =>
    api.post<StudentLeaveRequestDto>(`${A}/me/leaves`, b),
  cancelLeave: (id: number) => api.post<StudentLeaveRequestDto>(`${A}/me/leaves/${id}/cancel`),

  branches: () => api.get<BranchRef[]>('/branches'),
  batches: () => api.get<Paginated<BatchDto>>('/academics/batches', { pageSize: 100 }),
};

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  leave: 'Leave',
  half_day: 'Half day',
};
export const STATUS_SHORT: Record<AttendanceStatus, string> = {
  present: 'P',
  absent: 'A',
  late: 'L',
  leave: 'LV',
  half_day: 'H',
};
export const STATUS_COLOR: Record<AttendanceStatus, string> = {
  present: 'success',
  absent: 'danger',
  late: 'warning',
  leave: 'medium',
  half_day: 'tertiary',
};

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const pct = (p: number | null | undefined) => (p == null ? '—' : `${p}%`);
