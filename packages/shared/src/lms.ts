/** Learning management & content (spec §4.8): shared constants and DTOs. */

export const LMS_RESOURCE_TYPES = ['video', 'notes', 'ppt', 'document', 'link'] as const;
export type LmsResourceType = (typeof LMS_RESOURCE_TYPES)[number];

export const LMS_RESOURCE_STATUSES = ['draft', 'published', 'archived'] as const;
export type LmsResourceStatus = (typeof LMS_RESOURCE_STATUSES)[number];

/** `free`: any learner of the institute (or of the restricted batches); `paid`: needs a course entitlement. */
export const LMS_ACCESS_TYPES = ['free', 'paid'] as const;
export type LmsAccessType = (typeof LMS_ACCESS_TYPES)[number];

export const LMS_TRANSCODE_STATUSES = [
  'none',
  'pending',
  'processing',
  'ready',
  'failed',
  'unavailable',
] as const;
export type LmsTranscodeStatus = (typeof LMS_TRANSCODE_STATUSES)[number];

export const LMS_ASSIGNMENT_STATUSES = ['draft', 'published', 'closed'] as const;
export type LmsAssignmentStatus = (typeof LMS_ASSIGNMENT_STATUSES)[number];

export const LMS_SUBMISSION_STATUSES = ['submitted', 'graded', 'returned'] as const;
export type LmsSubmissionStatus = (typeof LMS_SUBMISSION_STATUSES)[number];

/** Chunk size for resumable uploads (bytes). The server accepts chunks up to this size. */
export const LMS_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** Largest single upload accepted by the chunked upload endpoint. */
export const LMS_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export interface LmsFileRef {
  id: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  /** Short-lived signed URL (only included where the caller may open the file). */
  url?: string;
  expiresAt?: string;
}

export interface LmsResourceInput {
  courseId: number;
  subjectId?: number | null;
  chapterId?: number | null;
  topicId?: number | null;
  branchId?: number | null;
  /** Restrict to these batches of the course; empty = every batch of the course. */
  batchIds?: number[];
  title: string;
  description?: string | null;
  type: LmsResourceType;
  fileId?: number | null;
  externalUrl?: string | null;
  durationSeconds?: number | null;
  access?: LmsAccessType;
  /** Time-limited access: days from the start of the learner's entitlement. null = lifetime. */
  accessDays?: number | null;
  availableFrom?: string | null;
  availableUntil?: string | null;
  /** Notes/documents: learners may download the file. Never applies to videos on the web. */
  downloadable?: boolean;
  /** Videos: allow encrypted in-app offline download on mobile. */
  offlineAllowed?: boolean;
  /** Hours an offline copy stays playable before it must be renewed. */
  offlineExpiryHours?: number;
  sortOrder?: number;
}

export interface LmsResourceDto {
  id: number;
  courseId: number;
  courseName?: string;
  subjectId: number | null;
  chapterId: number | null;
  topicId: number | null;
  branchId: number | null;
  batchIds: number[];
  title: string;
  description: string | null;
  type: LmsResourceType;
  status: LmsResourceStatus;
  access: LmsAccessType;
  accessDays: number | null;
  availableFrom: string | null;
  availableUntil: string | null;
  downloadable: boolean;
  offlineAllowed: boolean;
  offlineExpiryHours: number;
  durationSeconds: number | null;
  sortOrder: number;
  externalUrl: string | null;
  file: LmsFileRef | null;
  transcodeStatus: LmsTranscodeStatus;
  publishedAt: string | null;
  createdAt: string;
}

export interface LmsProgressDto {
  positionSeconds: number;
  durationSeconds: number | null;
  watchedSeconds: number;
  percent: number;
  completed: boolean;
  completedAt: string | null;
  lastViewedAt: string | null;
}

/** A resource as seen by a learner: lock state, access expiry and own progress. */
export interface LmsLearnerResourceDto extends LmsResourceDto {
  locked: boolean;
  lockReason: 'not-entitled' | 'expired' | 'not-yet-available' | null;
  accessUntil: string | null;
  progress: LmsProgressDto | null;
}

export interface LmsTopicNode {
  id: number;
  name: string;
  resources: LmsLearnerResourceDto[];
}
export interface LmsChapterNode {
  id: number;
  name: string;
  topics: LmsTopicNode[];
  resources: LmsLearnerResourceDto[];
}
export interface LmsSubjectNode {
  id: number;
  name: string;
  chapters: LmsChapterNode[];
  resources: LmsLearnerResourceDto[];
}
export interface LmsCourseContentsDto {
  course: { id: number; name: string; code: string };
  entitled: boolean;
  entitlementUntil: string | null;
  subjects: LmsSubjectNode[];
  /** Resources not filed under a subject. */
  resources: LmsLearnerResourceDto[];
  stats: { total: number; completed: number; percent: number };
}

export interface LmsLibraryCourseDto {
  id: number;
  name: string;
  code: string;
  entitled: boolean;
  entitlementUntil: string | null;
  resourceCount: number;
  completedCount: number;
  percent: number;
}

export interface LmsPlaybackDto {
  resourceId: number;
  /** `hls`: m3u8 playlist; `mp4`: progressive file with Range support; `file`: notes/documents; `link`: external URL. */
  kind: 'hls' | 'mp4' | 'file' | 'link';
  url: string;
  mimeType: string | null;
  expiresAt: string | null;
  /** Dynamic watermark overlay drawn by the player. */
  watermark: { text: string };
  resumeAtSeconds: number;
  downloadable: boolean;
  offlineAllowed: boolean;
}

export interface LmsProgressInput {
  positionSeconds: number;
  durationSeconds?: number | null;
  /** Seconds actually watched since the previous report (capped server-side). */
  watchedDeltaSeconds?: number;
  completed?: boolean;
}

export interface LmsOfflineLicenseDto {
  id: number;
  resourceId: number;
  title: string;
  /**
   * Signed source URL for the one-time download into the app's private storage: open it at once. It works for
   * 10 minutes, and only while this device is signed in.
   */
  downloadUrl: string;
  downloadUrlExpiresAt: string;
  /** Base64 AES-256-GCM key the app uses to encrypt the copy at rest. */
  contentKey: string;
  expiresAt: string;
  mimeType: string;
  sizeBytes: number;
  watermark: { text: string };
}

export interface LmsOfflineLicenseSummary {
  id: number;
  resourceId: number;
  title: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface LmsUploadSessionDto {
  uploadId: string;
  fileName: string;
  mimeType: string;
  totalBytes: number;
  receivedBytes: number;
  chunkBytes: number;
  status: 'uploading' | 'completed' | 'aborted';
  file: LmsFileRef | null;
  expiresAt: string;
}

export interface LmsGrantInput {
  studentUserId: number;
  courseId: number;
  /** null/omitted = lifetime. */
  validUntil?: string | null;
  note?: string | null;
}

export interface LmsGrantDto {
  id: number;
  studentUserId: number;
  studentName: string | null;
  courseId: number;
  courseName: string | null;
  validFrom: string;
  validUntil: string | null;
  source: string;
  note: string | null;
  createdAt: string;
}

export interface LmsAssignmentInput {
  batchId: number;
  subjectId?: number | null;
  chapterId?: number | null;
  topicId?: number | null;
  title: string;
  instructions?: string | null;
  dueAt: string;
  maxMarks?: number | null;
  allowLate?: boolean;
  fileIds?: number[];
}

export interface LmsUserRef {
  id: number;
  name: string;
}

export interface LmsSubmissionDto {
  id: number;
  assignmentId: number;
  student: LmsUserRef;
  text: string | null;
  status: LmsSubmissionStatus;
  isLate: boolean;
  submittedAt: string;
  marks: number | null;
  feedback: string | null;
  gradedBy: LmsUserRef | null;
  gradedAt: string | null;
  files: LmsFileRef[];
}

export interface LmsAssignmentDto {
  id: number;
  batchId: number;
  batchName: string | null;
  branchId: number;
  subjectId: number | null;
  subjectName: string | null;
  chapterId: number | null;
  topicId: number | null;
  title: string;
  instructions: string | null;
  dueAt: string;
  maxMarks: number | null;
  allowLate: boolean;
  status: LmsAssignmentStatus;
  publishedAt: string | null;
  createdBy: LmsUserRef | null;
  files: LmsFileRef[];
  /** Staff: submission counters. */
  counts?: { students: number; submitted: number; graded: number };
  /** Learner/parent views: the student's own submission. */
  mySubmission?: LmsSubmissionDto | null;
  /** Parent view: whose homework this is. */
  student?: LmsUserRef;
}

export interface LmsSubmitInput {
  text?: string | null;
  fileIds?: number[];
}

export interface LmsGradeInput {
  marks?: number | null;
  feedback?: string | null;
  /** `returned` asks the student to resubmit. */
  status?: 'graded' | 'returned';
}

export interface LmsResourceAnalyticsRow {
  student: LmsUserRef;
  percent: number;
  watchedSeconds: number;
  completed: boolean;
  lastViewedAt: string | null;
}
