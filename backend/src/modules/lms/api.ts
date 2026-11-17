/**
 * Public LMS API for other modules. Import only from this file.
 *
 * Fees (or any module that sells courses) decides paid-content access by registering a provider
 * from its `integrations.ts` `onReady` hook:
 *
 *   import { setCourseEntitlementProvider } from '../lms/api';
 *   setCourseEntitlementProvider({
 *     async hasCourseEntitlement(q, batchDefault) {
 *       // e.g. paid-up or within grace → { entitled: true, since, until, source: 'fees' }
 *       return batchDefault(q);
 *     },
 *   });
 */
export {
  setCourseEntitlementProvider,
  resolveCourseEntitlement,
  batchEnrolmentEntitlement,
  type CourseEntitlement,
  type CourseEntitlementProvider,
  type EntitlementQuery,
} from './entitlements';
export { setVideoTranscoder, type VideoTranscoder } from './transcoder';
export { LmsResource, LmsAssignment, LmsSubmission, LmsProgress } from './models';
