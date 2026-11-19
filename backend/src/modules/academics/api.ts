/** Public cross-module API of the academics module. Import from here, not from internal files. */
export {
  activeBatchForCourse,
  batchAvailability,
  batchUnavailableError,
  enrollStudentsInBatch,
  getBatchMemberUserIds,
  leaveBatch,
  openBatchesForCourse,
  type BatchUnavailableReason,
} from './academics.service';
export { onClassSessionCompleted, type ClassCompletedEvent } from './class-events';
export {
  setPromotionFeeProvider,
  type PromotionFeePlan,
  type PromotionFeeProvider,
  type PromotionFeeTarget,
} from './promotion-fees';
export { completeClassSession, type CompleteClassOptions } from './class-completion';
export {
  AcademicSession,
  Batch,
  BatchStudent,
  BatchTeacher,
  Chapter,
  ClassSession,
  Course,
  CourseSubject,
  Subject,
  Topic,
} from './models';

/** Read-only report queries (reports module, spec §4.17); callers pass a validated `ReportScope`. */
export { capacityReport, teachingReport } from './reporting';
