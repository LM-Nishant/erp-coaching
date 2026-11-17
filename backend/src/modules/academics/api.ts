/** Public cross-module API of the academics module. Import from here, not from internal files. */
export { enrollStudentsInBatch, getBatchMemberUserIds } from './academics.service';
export { onClassSessionCompleted, type ClassCompletedEvent } from './class-events';
export { AcademicSession, Batch, BatchStudent, BatchTeacher, ClassSession, Course, Subject } from './models';
