/**
 * Course marketplace — learner engagement: ratings & reviews, course Q&A and the wishlist.
 * Builds on `marketplace.ts` (cards, pages).
 */
import type { MktCourseCardDto, MktPage } from './marketplace';

// ---------------------------------------------------------------- ratings & reviews

export const MKT_REVIEW_SORTS = ['recent', 'highest', 'lowest'] as const;
export type MktReviewSort = (typeof MKT_REVIEW_SORTS)[number];
export const MKT_REVIEW_SORT_LABELS: Record<MktReviewSort, string> = {
  recent: 'Most recent',
  highest: 'Highest rating',
  lowest: 'Lowest rating',
};

export const MKT_REVIEW_STATUSES = ['visible', 'hidden'] as const;
export type MktReviewStatus = (typeof MKT_REVIEW_STATUSES)[number];

export const MKT_REVIEW_MAX_BODY = 4000;
export const MKT_QA_MAX_BODY = 5000;

export interface MktReviewReplyDto {
  body: string;
  sellerName: string;
  repliedAt: string;
}

export interface MktCourseReviewDto {
  id: number;
  courseId: number;
  rating: number;
  title: string | null;
  body: string | null;
  /** Learner's display name (first name + initial). */
  authorName: string;
  /** The signed-in user wrote it. */
  mine: boolean;
  reply: MktReviewReplyDto | null;
  createdAt: string;
  updatedAt: string;
}

/** Counts per star, index 0 = 1 star … index 4 = 5 stars. */
export type MktRatingBreakdown = [number, number, number, number, number];

export interface MktReviewSummaryDto {
  ratingAvg: number;
  ratingCount: number;
  breakdown: MktRatingBreakdown;
}

export interface MktReviewListDto extends MktPage<MktCourseReviewDto> {
  summary: MktReviewSummaryDto;
}

export interface MktReviewInput {
  rating: number;
  title?: string | null;
  body?: string | null;
}

/** The signed-in learner's standing on a course's reviews. */
export interface MktMyReviewDto {
  /** Enrolled learners may review. */
  canReview: boolean;
  review: MktCourseReviewDto | null;
}

/** Studio (seller) and admin views carry the course and moderation fields. */
export interface MktManagedReviewDto extends MktCourseReviewDto {
  course: { id: number; slug: string; title: string };
  status: MktReviewStatus;
  reportCount: number;
  hiddenReason: string | null;
  reports: { reason: string; createdAt: string }[];
}

// ---------------------------------------------------------------- Q&A

export interface MktAnswerDto {
  id: number;
  body: string;
  authorName: string;
  /** Written by the course's seller (instructor / institute staff). */
  isInstructor: boolean;
  mine: boolean;
  createdAt: string;
}

export interface MktQuestionDto {
  id: number;
  courseId: number;
  lectureId: number | null;
  lectureTitle: string | null;
  title: string;
  body: string | null;
  authorName: string;
  mine: boolean;
  answered: boolean;
  answerCount: number;
  createdAt: string;
  /** Included on the question detail and in the studio inbox. */
  answers?: MktAnswerDto[];
}

export interface MktQuestionQuery {
  lectureId?: number;
  /** `unanswered` = not marked answered; `mine` = asked by me. */
  filter?: 'all' | 'unanswered' | 'mine';
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface MktQuestionInput {
  title: string;
  body?: string | null;
  lectureId?: number | null;
}

/** Studio inbox: questions across the seller's courses. */
export interface MktStudioQuestionDto extends MktQuestionDto {
  course: { id: number; slug: string; title: string };
}

// ---------------------------------------------------------------- wishlist

export interface MktWishlistDto {
  items: MktCourseCardDto[];
}
