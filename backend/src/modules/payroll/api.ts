/**
 * Public cross-module API of the payroll module. Import from here, not from internal files.
 * Report queries (reports module, spec §4.17) take a validated `ReportScope`.
 */
export { payrollReport } from './reporting';
