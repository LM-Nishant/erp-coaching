import type { MktCourseStatus } from '@erp/shared';

export const STATUS_COLORS: Record<MktCourseStatus, string> = {
  draft: 'medium',
  in_review: 'warning',
  published: 'success',
  rejected: 'danger',
  unpublished: 'dark',
};
