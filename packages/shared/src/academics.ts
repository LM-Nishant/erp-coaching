/**
 * Academics module DTOs (spec §4.4). Other modules (fees, attendance, LMS, exams) reference
 * these ids: `academicSessionId`, `courseId`, `subjectId`, `chapterId`, `topicId`, `batchId`,
 * `classroomId` and `classSessionId`.
 *
 * Dates are `YYYY-MM-DD`; class times are institute-local wall-clock `HH:MM` (24h).
 */

export const COURSE_MODES = ['offline', 'online', 'hybrid'] as const;
export type CourseMode = (typeof COURSE_MODES)[number];

export const DURATION_UNITS = ['days', 'weeks', 'months', 'years'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export type AcademicSessionStatus = 'planned' | 'active' | 'closed';
export type BatchStatus = 'planned' | 'active' | 'completed' | 'cancelled';
export type EnrollmentStatus = 'active' | 'promoted' | 'completed' | 'left';
export type ClassSessionStatus = 'scheduled' | 'completed' | 'cancelled';
export type ClassNoteKind = 'note' | 'homework';

/** 0 = Sunday … 6 = Saturday. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface AcademicSessionDto {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  status: AcademicSessionStatus;
}

export interface CourseCategoryDto {
  id: number;
  name: string;
  description: string | null;
}

export interface CourseDto {
  id: number;
  categoryId: number | null;
  name: string;
  code: string;
  description: string | null;
  mode: CourseMode;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  isTemplate: boolean;
  templateId: number | null;
  status: 'active' | 'archived';
  branchIds: number[];
  subjectIds: number[];
}

export interface SubjectDto {
  id: number;
  name: string;
  code: string | null;
}

export interface ChapterDto {
  id: number;
  subjectId: number;
  name: string;
  sortOrder: number;
}

export interface TopicDto {
  id: number;
  chapterId: number;
  name: string;
  sortOrder: number;
  durationMinutes: number | null;
}

export interface UserRefDto {
  id: number;
  name: string;
}

export interface BatchTeacherDto {
  teacherUserId: number;
  subjectId: number | null;
  teacher?: UserRefDto;
}

export interface BatchDto {
  id: number;
  branchId: number;
  courseId: number;
  academicSessionId: number;
  name: string;
  code: string;
  capacity: number;
  startDate: string;
  endDate: string | null;
  mode: CourseMode;
  status: BatchStatus;
  teachers: BatchTeacherDto[];
  enrolledCount?: number;
}

export interface BatchStudentDto {
  id: number;
  batchId: number;
  studentUserId: number;
  status: EnrollmentStatus;
  joinedOn: string;
  leftOn: string | null;
  promotedFromId: number | null;
  student?: UserRefDto;
}

export interface PromotionRequest {
  fromBatchId: number;
  toBatchId: number;
  /** Defaults to every active student of the source batch. */
  studentUserIds?: number[];
}

export interface PromotionResult {
  promoted: number;
  skipped: { studentUserId: number; reason: string }[];
}

export interface ClassroomDto {
  id: number;
  branchId: number;
  name: string;
  capacity: number;
  isVirtual: boolean;
  status: 'active' | 'inactive';
}

export interface ScheduleDto {
  id: number;
  branchId: number;
  batchId: number;
  subjectId: number | null;
  teacherUserId: number;
  classroomId: number | null;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface GenerateSessionsRequest {
  from: string;
  to: string;
  batchId?: number;
}

export interface GenerateSessionsResult {
  created: number;
  skippedExisting: number;
  conflicts: { scheduleId: number; date: string; reason: string }[];
}

export interface ClassSessionDto {
  id: number;
  branchId: number;
  batchId: number;
  subjectId: number | null;
  scheduleId: number | null;
  teacherUserId: number;
  originalTeacherUserId: number | null;
  classroomId: number | null;
  date: string;
  startTime: string;
  endTime: string;
  status: ClassSessionStatus;
  rescheduledFrom: string | null;
  cancelReason: string | null;
  actualDurationMinutes: number | null;
  completionNotes: string | null;
  completedAt: string | null;
  batch?: { id: number; name: string; courseId: number };
  subject?: { id: number; name: string } | null;
  teacher?: UserRefDto;
  classroom?: { id: number; name: string } | null;
}

export interface RescheduleRequest {
  date: string;
  startTime: string;
  endTime: string;
  classroomId?: number | null;
  reason?: string;
}

export interface ClassNoteAttachmentDto {
  fileId: number;
  name: string;
  mimeType: string;
  url: string;
}

export interface ClassNoteCommentDto {
  id: number;
  userId: number;
  body: string;
  createdAt: string;
  user?: UserRefDto;
}

export interface ClassNoteDto {
  id: number;
  classSessionId: number;
  authorUserId: number;
  kind: ClassNoteKind;
  title: string;
  body: string | null;
  dueDate: string | null;
  attachments: ClassNoteAttachmentDto[];
  comments: ClassNoteCommentDto[];
  createdAt: string;
}

/** Background job emitted on reschedule / cancel / substitution. */
export const ACADEMICS_CLASS_CHANGED_JOB = 'academics.class-changed';
export interface ClassChangedJobPayload {
  classSessionId: number;
  change: 'rescheduled' | 'cancelled' | 'substituted';
}
