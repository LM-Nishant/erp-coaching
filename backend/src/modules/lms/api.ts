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
export { getVideoTranscoder, setVideoTranscoder, type VideoTranscoder } from './transcoder';
/** Deletes an HLS rendition written next to its `manifest.json` (marketplace reuses the LMS pipeline). */
export { removeRendition } from './transcode.job';
export { LmsResource, LmsAssignment, LmsSubmission, LmsProgress } from './models';

/** Read-only report queries (reports module, spec §4.17); callers pass a validated `ReportScope`. */
export { lmsEngagementReport } from './reporting';
