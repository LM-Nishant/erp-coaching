/**
 * Doubts: a student asks a question (text and/or a photo), optionally about a lecture, live class or
 * subject; the batch's subject teacher answers it and the student marks it solved.
 */

/** `open`: waiting for a teacher. `answered`: a teacher replied. `resolved`: solved, closed. */
export const DOUBT_STATUSES = ['open', 'answered', 'resolved'] as const;
export type DoubtStatus = (typeof DOUBT_STATUSES)[number];

/** Which list to load: the student's own doubts, the teacher's inbox, or every doubt (staff). */
export const DOUBT_BOXES = ['mine', 'inbox', 'all'] as const;
export type DoubtBox = (typeof DOUBT_BOXES)[number];

export const DOUBT_QUESTION_MAX = 2000;

export interface DoubtUserRef {
  id: number;
  name: string;
}

export interface DoubtDto {
  id: number;
  status: DoubtStatus;
  question: string;
  hasPhoto: boolean;
  student: DoubtUserRef | null;
  teacher: DoubtUserRef | null;
  batch: { id: number; name: string } | null;
  subject: { id: number; name: string } | null;
  /** The lecture the doubt is about, with the video position (seconds) when asked from the player. */
  lecture: { id: number; title: string; positionSeconds: number | null } | null;
  liveClass: { id: number; title: string } | null;
  replyCount: number;
  lastActivityAt: string;
  answeredAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface DoubtReplyDto {
  id: number;
  author: DoubtUserRef | null;
  /** Written by someone answering (teacher/staff), not the student who asked. */
  fromTeacher: boolean;
  body: string | null;
  /** Short-lived signed link to the photo, when there is one. */
  photoUrl: string | null;
  createdAt: string;
}

export interface DoubtDetailDto extends DoubtDto {
  photoUrl: string | null;
  replies: DoubtReplyDto[];
  /** The caller may answer (teacher of the batch, or staff who see every doubt). */
  canAnswer: boolean;
  /** The caller asked it. */
  isMine: boolean;
}

/** Fields of `POST /doubts` (multipart; an optional photo goes in `file`). */
export interface AskDoubtInput {
  question: string;
  batchId?: number | null;
  subjectId?: number | null;
  lectureId?: number | null;
  positionSeconds?: number | null;
  liveClassId?: number | null;
}

/** Batches the student can ask in, with their subjects (`GET /doubts/options`). */
export interface DoubtOptionsDto {
  batches: { id: number; name: string; subjects: { id: number; name: string }[] }[];
}

/** Badge counts (`GET /doubts/counts`): open doubts waiting in the caller's inbox, answers waiting for the student. */
export interface DoubtCountsDto {
  waiting: number;
  answered: number;
}
