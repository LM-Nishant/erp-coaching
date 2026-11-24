import type {
  MktCartDto,
  MktManagedReviewDto,
  MktMyReviewDto,
  MktPage,
  MktQuestionDto,
  MktQuestionInput,
  MktQuestionQuery,
  MktRatingBreakdown,
  MktReviewInput,
  MktReviewListDto,
  MktReviewSort,
  MktReviewStatus,
  MktStudioQuestionDto,
  MktWishlistDto,
} from '@erp/shared';
import { api } from '@/core/api';
import type { StudioScope } from './api';

type Q = Record<string, string | number | boolean | null | undefined>;
type Ids = { courseIds: number[] };

/** Ratings & reviews, course Q&A and the wishlist. */
export const engagementApi = {
  reviews: (
    slug: string,
    q: { sort?: MktReviewSort; rating?: number; page?: number; pageSize?: number } = {},
  ) =>
    api.get<MktReviewListDto>(`/marketplace/public/courses/${encodeURIComponent(slug)}/reviews`, q as Q, {
      anonymous: true,
    }),
  myReview: (courseId: number) => api.get<MktMyReviewDto>(`/marketplace/courses/${courseId}/reviews/me`),
  saveReview: (courseId: number, input: MktReviewInput) =>
    api.put<MktMyReviewDto>(`/marketplace/courses/${courseId}/reviews/me`, input),
  deleteReview: (courseId: number) => api.delete(`/marketplace/courses/${courseId}/reviews/me`),
  reportReview: (id: number, reason: string) =>
    api.post<{ reported: boolean }>(`/marketplace/reviews/${id}/report`, { reason }),

  questions: (courseId: number, q: MktQuestionQuery = {}) =>
    api.get<MktPage<MktQuestionDto>>(`/marketplace/courses/${courseId}/questions`, q as Q),
  question: (courseId: number, id: number) =>
    api.get<MktQuestionDto>(`/marketplace/courses/${courseId}/questions/${id}`),
  ask: (courseId: number, input: MktQuestionInput) =>
    api.post<MktQuestionDto>(`/marketplace/courses/${courseId}/questions`, input),
  answer: (courseId: number, id: number, body: string) =>
    api.post<MktQuestionDto>(`/marketplace/courses/${courseId}/questions/${id}/answers`, { body }),
  setAnswered: (courseId: number, id: number, answered: boolean) =>
    api.put<MktQuestionDto>(`/marketplace/courses/${courseId}/questions/${id}/answered`, { answered }),
  deleteQuestion: (courseId: number, id: number) =>
    api.delete(`/marketplace/courses/${courseId}/questions/${id}`),

  wishlist: () => api.get<MktWishlistDto>('/marketplace/wishlist'),
  wishlistIds: () => api.get<Ids>('/marketplace/wishlist/ids'),
  addToWishlist: (courseId: number) => api.post<Ids>('/marketplace/wishlist', { courseId }),
  removeFromWishlist: (courseId: number) => api.delete<Ids>(`/marketplace/wishlist/${courseId}`),
  moveToCart: (courseId: number) => api.post<MktCartDto>(`/marketplace/wishlist/${courseId}/move-to-cart`),
};

/** The seller's reviews and Q&A inbox for one storefront. */
export function studioEngagementApi(scope: StudioScope) {
  const base = `/marketplace/${scope}`;
  return {
    reviews: (q: { courseId?: number; unreplied?: boolean; page?: number } = {}) =>
      api.get<MktPage<MktManagedReviewDto>>(`${base}/reviews`, q as Q),
    reply: (id: number, body: string | null) =>
      api.put<MktManagedReviewDto>(`${base}/reviews/${id}/reply`, { body }),
    questions: (q: MktQuestionQuery & { courseId?: number } = {}) =>
      api.get<MktPage<MktStudioQuestionDto>>(`${base}/questions`, q as Q),
    answer: (id: number, body: string) =>
      api.post<MktStudioQuestionDto>(`${base}/questions/${id}/answers`, { body }),
    setAnswered: (id: number, answered: boolean) =>
      api.put<MktStudioQuestionDto>(`${base}/questions/${id}/answered`, { answered }),
  };
}

export const adminReviewsApi = {
  list: (q: { status?: MktReviewStatus; reported?: boolean; courseId?: number; page?: number } = {}) =>
    api.get<MktPage<MktManagedReviewDto>>('/admin/marketplace/reviews', q as Q),
  hide: (id: number, reason: string | null) =>
    api.post<MktManagedReviewDto>(`/admin/marketplace/reviews/${id}/hide`, { reason }),
  unhide: (id: number) => api.post<MktManagedReviewDto>(`/admin/marketplace/reviews/${id}/unhide`),
};

/** Share of ratings per star (5 → 1), as whole percentages for the breakdown bars. */
export function breakdownPercents(
  breakdown: MktRatingBreakdown,
): { stars: number; count: number; percent: number }[] {
  const total = breakdown.reduce((a, b) => a + b, 0);
  return [5, 4, 3, 2, 1].map((stars) => {
    const count = breakdown[stars - 1];
    return { stars, count, percent: total ? Math.round((count / total) * 100) : 0 };
  });
}

/** Star glyphs for a rating, rounded to the nearest half: full, half and empty counts. */
export function starParts(rating: number): { full: number; half: boolean; empty: number } {
  const r = Math.max(0, Math.min(5, Math.round(rating * 2) / 2));
  const full = Math.floor(r);
  const half = r - full === 0.5;
  return { full, half, empty: 5 - full - (half ? 1 : 0) };
}

export function relativeDate(iso: string, now = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? 'a month ago' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years <= 1 ? 'a year ago' : `${years} years ago`;
}
