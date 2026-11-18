/** Public cross-module API of the fees module (LMS, exams, live classes…). */
export { hasCourseEntitlement, hasSubjectEntitlement, entitledCourseIds } from './entitlements';
export { setPlatformFeesGatewayProvider, type PlatformFeesGatewayProvider } from './gateways.service';
