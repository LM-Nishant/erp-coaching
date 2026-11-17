/** HR module (spec §4.7): staff profiles, attendance, leave, assets and separation. */

export const EMPLOYEE_STATUSES = ['active', 'on_notice', 'exited', 'suspended'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'visiting'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const STAFF_ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'leave', 'half_day'] as const;
export type StaffAttendanceStatus = (typeof STAFF_ATTENDANCE_STATUSES)[number];

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type SeparationType = 'resignation' | 'termination' | 'retirement';
export type SeparationStatus = 'submitted' | 'accepted' | 'rejected' | 'withdrawn' | 'completed';
export type AssetStatus = 'issued' | 'returned' | 'lost';
export type ContractStatus = 'draft' | 'active' | 'expired' | 'terminated';

export interface EmployeeDto {
  id: number;
  branchId: number | null;
  userId: number | null;
  employeeCode: string;
  name: string;
  email: string | null;
  mobile: string | null;
  designation: string | null;
  department: string | null;
  employmentType: EmploymentType;
  isTeacher: boolean;
  dateOfJoining: string;
  dateOfBirth: string | null;
  dateOfExit: string | null;
  gender: string | null;
  address: string | null;
  pan: string | null;
  uan: string | null;
  esiNumber: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  shiftId: number | null;
  biometricEnrolmentId: string | null;
  status: EmployeeStatus;
  notes: string | null;
}

export interface LeaveTypeDto {
  id: number;
  code: string;
  name: string;
  /** Days per calendar year; null = unlimited. */
  annualQuota: number | null;
  paid: boolean;
  encashable: boolean;
  active: boolean;
}

export interface LeaveBalanceDto {
  leaveTypeId: number;
  code: string;
  name: string;
  quota: number | null;
  used: number;
  pending: number;
  available: number | null;
}

export interface LeaveApplicationDto {
  id: number;
  employeeId: number;
  leaveTypeId: number;
  fromDate: string;
  toDate: string;
  halfDay: boolean;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  employee?: { id: number; name: string; employeeCode: string };
  leaveType?: { id: number; name: string; code: string };
}

export interface StaffAttendanceDto {
  id: number;
  employeeId: number;
  date: string;
  status: StaffAttendanceStatus;
  checkIn: string | null;
  checkOut: string | null;
  source: 'manual' | 'biometric' | 'leave';
  remarks: string | null;
}
