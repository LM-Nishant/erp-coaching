/** Public cross-module API of the fees module (LMS, exams, live classes…). */
export { hasCourseEntitlement, hasSubjectEntitlement, entitledCourseIds } from './entitlements';

/** Read-only report queries (reports module, spec §4.17); callers pass a validated `ReportScope`. */
export { feeCollectionReport, outstandingDuesReport } from './reporting';
export { setPlatformFeesGatewayProvider, type PlatformFeesGatewayProvider } from './gateways.service';
