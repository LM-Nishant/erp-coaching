/** Parent/guardian portal dashboard and monthly reports (spec §4.12). */

/** A child the signed-in parent is actively linked to; passed to every parent-home widget. */
export interface ParentChildDto {
  /** `students.id` (students/guardians/fees key). */
  studentId: number;
  /** Login user id of the student (academics rosters, grievances, attendance key); null without a login. */
  studentUserId: number | null;
  name: string;
  admissionNumber: string | null;
  branchId: number;
  branchName: string | null;
  batches: { id: number; name: string }[];
}

export interface ParentTimetableItemDto {
  classSessionId: number;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  batchId: number;
  batchName: string | null;
  subject: string | null;
  teacher: string | null;
}

export interface ParentTimetableDto {
  from: string;
  to: string;
  items: ParentTimetableItemDto[];
}

export type ParentMetricTone = 'default' | 'success' | 'warning' | 'danger';

/**
 * One block of data contributed by a backend provider (fees dues, attendance %, latest results…).
 * Rendered generically in the parent home "Summary" card and in monthly reports.
 */
export interface ParentPortalSectionDto {
  key: string;
  label: string;
  metrics: { label: string; value: string | number; hint?: string; tone?: ParentMetricTone }[];
  items: { title: string; subtitle?: string; date?: string; link?: string }[];
}

export interface ParentMonthlyReportDto {
  id: number;
  studentId: number;
  studentName: string | null;
  /** `YYYY-MM`. */
  period: string;
  sections: ParentPortalSectionDto[];
  generatedAt: string;
}

export const PARENT_MONTHLY_REPORT_JOB = 'parent-portal.monthly-report';
export const PARENT_MONTHLY_REPORT_EVENT = 'parent-portal.monthly-report';
