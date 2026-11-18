/**
 * Public exams API for other modules. Import only from this file.
 *
 * A module that sells courses (fees) can gate paid exams from its `integrations.ts`:
 *
 *   import { setExamEntitlementProvider } from '../exams/api';
 *   setExamEntitlementProvider(async ({ instituteId, studentUserId, courseId }) => true);
 */
export {
  setExamEntitlementProvider,
  type ExamEntitlementProvider,
  type ExamEntitlementQuery,
} from './entitlements';

/** Read-only report queries (reports module, spec §4.17); callers pass a validated `ReportScope`. */
export { examReport } from './reporting';
