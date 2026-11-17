/** Payroll module (spec §4.7). All money values are integer paise. */

export const PAY_TYPES = ['fixed_monthly', 'per_lecture', 'per_class'] as const;
export type PayType = (typeof PAY_TYPES)[number];

export type PayrollRunStatus = 'draft' | 'approved' | 'locked';
export type PayslipLineType = 'earning' | 'deduction' | 'employer';
export type WorkUnitType = 'lecture' | 'class' | 'incentive';

export interface PayslipLine {
  code: string;
  name: string;
  type: PayslipLineType;
  amount: number;
}

/** Fixed monthly allowance/deduction configured on a salary structure. */
export interface StructureItem {
  name: string;
  amount: number;
}

export interface ComponentSlab {
  /** Upper bound of the base (inclusive) in paise; null = no upper bound. */
  upTo: number | null;
  amount: number;
}

export interface PayrollComponentDto {
  id: number;
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  statutory: boolean;
  calcType: 'percent' | 'fixed' | 'slab';
  base: 'basic' | 'gross';
  employeeRate: number | null;
  employerRate: number | null;
  fixedAmount: number | null;
  wageCeiling: number | null;
  eligibilityMaxGross: number | null;
  slabs: ComponentSlab[] | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  sortOrder: number;
}

export interface PayrollRunDto {
  id: number;
  branchId: number | null;
  periodYear: number;
  periodMonth: number;
  status: PayrollRunStatus;
  employeeCount: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
  totalEmployer: number;
  generatedAt: string | null;
  approvedAt: string | null;
  lockedAt: string | null;
  notes: string | null;
}

export interface PayslipDto {
  id: number;
  payrollRunId: number;
  employeeId: number;
  periodYear: number;
  periodMonth: number;
  payType: PayType;
  daysInMonth: number;
  employedDays: number;
  lopDays: number;
  payableDays: number;
  attendance: Record<string, number>;
  units: { lecture: number; class: number };
  lines: PayslipLine[];
  gross: number;
  totalDeductions: number;
  net: number;
  employerContributions: number;
  employee?: { id: number; name: string; employeeCode: string; designation: string | null };
}

export type SettlementStatus = 'draft' | 'approved' | 'paid';
