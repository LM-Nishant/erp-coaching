/**
 * Public surface of the attendance module for other modules (e.g. live classroom joins).
 * `recordAttendance` needs a tenant context (request or job) and never overwrites an existing mark
 * unless `overwrite: true`.
 */
export { recordAttendance, type RecordAttendanceInput } from './sessions.service';
export { computeTotals, studentSummary } from './reports.service';
