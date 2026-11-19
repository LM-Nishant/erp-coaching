/**
 * Public surface of the attendance module for other modules (e.g. live classroom joins).
 * `recordAttendance` needs a tenant context (request or job) and never overwrites an existing mark
 * unless `overwrite: true`.
 */
export { recordAttendance, type RecordAttendanceInput } from './sessions.service';
export { computeTotals, studentSummary } from './reports.service';

/** Read-only report queries (reports module, spec §4.17); callers pass a validated `ReportScope`. */
export { attendanceReport } from './reporting';

/** Staff punches from biometric devices (HR registers the provider). */
export {
  setStaffPunchProvider,
  type StaffPin,
  type StaffPunchOutcome,
  type StaffPunchProvider,
} from './staff-punches';
