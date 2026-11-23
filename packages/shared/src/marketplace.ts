/**
 * Public course marketplace (Udemy-style): one catalog shared by every institute and by independent
 * instructors. The platform collects every payment and pays sellers from the sale ledger.
 * Amounts are in paise.
 */
import type { PaymentGatewayKey } from './fees';

/** `quiz` and other kinds are added later; the column is a plain string so new kinds need no migration. */
export const MKT_LECTURE_TYPES = ['video', 'article', 'resource'] as const;
export type MktLectureType = (typeof MKT_LECTURE_TYPES)[number];

export const MKT_COURSE_LEVELS = ['all', 'beginner', 'intermediate', 'advanced'] as const;
export type MktCourseLevel = (typeof MKT_COURSE_LEVELS)[number];
export const MKT_COURSE_LEVEL_LABELS: Record<MktCourseLevel, string> = {
  all: 'All levels',
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export const MKT_LANGUAGES = {
  en: 'English',
  hi: 'Hindi',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi',
  gu: 'Gujarati',
  kn: 'Kannada',
  ml: 'Malayalam',
  pa: 'Punjabi',
} as const;
export type MktLanguage = keyof typeof MKT_LANGUAGES;

/**
 * `draft` → (submit) `in_review` → `published` or `rejected` (back to the instructor with a reason);
 * a published course can be `unpublished` (hidden from the catalog; enrolled learners keep access).
 */
export const MKT_COURSE_STATUSES = ['draft', 'in_review', 'published', 'rejected', 'unpublished'] as const;
export type MktCourseStatus = (typeof MKT_COURSE_STATUSES)[number];
export const MKT_COURSE_STATUS_LABELS: Record<MktCourseStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
  rejected: 'Changes needed',
  unpublished: 'Unpublished',
};

export const MKT_SORTS = ['relevance', 'popular', 'rating', 'newest', 'price_asc', 'price_desc'] as const;
export type MktSort = (typeof MKT_SORTS)[number];
export const MKT_SORT_LABELS: Record<MktSort, string> = {
  relevance: 'Most relevant',
  popular: 'Most popular',
  rating: 'Highest rated',
  newest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
};

export const MKT_SELLER_TYPES = ['institute', 'instructor'] as const;
export type MktSellerType = (typeof MKT_SELLER_TYPES)[number];

export const MKT_SELLER_STATUSES = ['active', 'suspended'] as const;
export type MktSellerStatus = (typeof MKT_SELLER_STATUSES)[number];

export const MKT_ORDER_STATUSES = ['pending', 'paid', 'failed', 'cancelled', 'refunded'] as const;
export type MktOrderStatus = (typeof MKT_ORDER_STATUSES)[number];

export const MKT_MEDIA_KINDS = ['video', 'image', 'file'] as const;
export type MktMediaKind = (typeof MKT_MEDIA_KINDS)[number];

/** `ready`: playable (HLS, or the original MP4 where no transcoder is installed). */
export const MKT_MEDIA_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const;
export type MktMediaStatus = (typeof MKT_MEDIA_STATUSES)[number];

export const MKT_COUPON_KINDS = ['percent', 'amount'] as const;
export type MktCouponKind = (typeof MKT_COUPON_KINDS)[number];

/** Largest image (thumbnail) and downloadable resource accepted, bytes. Videos use the chunked upload. */
export const MKT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MKT_MAX_RESOURCE_BYTES = 100 * 1024 * 1024;
/** Chunk size for video uploads (bytes) and the largest video accepted. */
export const MKT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const MKT_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
export const MKT_MAX_PRICE_PAISE = 10_000_000;
/** A lecture counts as complete once this share of the video was reached (or when marked complete). */
export const MKT_COMPLETE_AT_PERCENT = 90;

export interface MktPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------- catalog

export interface MktCategoryDto {
  id: number;
  slug: string;
  name: string;
  parentId: number | null;
  icon: string | null;
  sortOrder: number;
  /** Published courses in the category (and its subcategories). */
  courseCount: number;
  children: MktCategoryDto[];
}

export interface MktSellerRef {
  id: number;
  slug: string;
  displayName: string;
  type: MktSellerType;
  avatarUrl: string | null;
}

export interface MktCourseCardDto {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  thumbnailUrl: string | null;
  seller: MktSellerRef;
  pricePaise: number;
  isFree: boolean;
  level: MktCourseLevel;
  language: string;
  categoryId: number | null;
  /** Filled by reviews (later); 0 with no ratings. */
  ratingAvg: number;
  ratingCount: number;
  enrolmentCount: number;
  lectureCount: number;
  durationSeconds: number;
  publishedAt: string | null;
  updatedAt: string;
}

export interface MktCatalogQuery {
  q?: string;
  /** Category or subcategory slug. */
  category?: string;
  level?: MktCourseLevel;
  language?: string;
  price?: 'free' | 'paid';
  /** Minimum average rating (0-5). */
  rating?: number;
  seller?: string;
  sort?: MktSort;
  page?: number;
  pageSize?: number;
}

export interface MktHomeDto {
  categories: MktCategoryDto[];
  featured: MktCourseCardDto[];
  newest: MktCourseCardDto[];
  free: MktCourseCardDto[];
}

export interface MktLectureOutlineDto {
  id: number;
  title: string;
  type: MktLectureType;
  durationSeconds: number;
  /** Free preview: anyone can open it from the landing page. */
  preview: boolean;
}

export interface MktSectionOutlineDto {
  id: number;
  title: string;
  lectures: MktLectureOutlineDto[];
}

export interface MktCourseDetailDto extends MktCourseCardDto {
  description: string | null;
  outcomes: string[];
  requirements: string[];
  audience: string[];
  category: { id: number; slug: string; name: string } | null;
  subcategory: { id: number; slug: string; name: string } | null;
  /** Signed promo video stream, when the course has one. */
  promo: MktStreamDto | null;
  sections: MktSectionOutlineDto[];
  /** Only for a signed-in learner. */
  enrolled: boolean;
  inCart: boolean;
}

export interface MktSellerPublicDto extends MktSellerRef {
  headline: string | null;
  bio: string | null;
  website: string | null;
  courseCount: number;
  studentCount: number;
  ratingAvg: number;
  ratingCount: number;
  courses: MktCourseCardDto[];
}

/** Short-lived signed playback: `hlsUrl` when transcoded, else `fileUrl` (progressive MP4). */
export interface MktStreamDto {
  hlsUrl: string | null;
  fileUrl: string | null;
  expiresAt: string;
}

// ---------------------------------------------------------------- learner accounts & instructors

export interface MktSignupInput {
  name: string;
  mobile: string;
  email?: string | null;
  password: string;
}

export interface MktInstructorProfileInput {
  displayName: string;
  headline?: string | null;
  bio?: string | null;
  website?: string | null;
  avatarMediaId?: number | null;
}

/** The signed-in user's marketplace standing: whether they can teach and as which seller(s). */
export interface MktAccountDto {
  /** The independent instructor profile, once created. */
  instructor: MktSellerAdminDto | null;
  /** The current institute's storefront, when the user may manage it. */
  institute: MktSellerAdminDto | null;
  cartCount: number;
}

// ---------------------------------------------------------------- course builder

export interface MktMediaDto {
  id: number;
  kind: MktMediaKind;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: MktMediaStatus;
  error: string | null;
  durationSeconds: number | null;
  /** Received bytes of a chunked upload. */
  receivedBytes: number;
  /** Signed URL for images (thumbnail preview). */
  url: string | null;
}

export interface MktLectureDto extends MktLectureOutlineDto {
  sectionId: number;
  sortOrder: number;
  description: string | null;
  articleBody: string | null;
  media: MktMediaDto | null;
}

export interface MktSectionDto {
  id: number;
  title: string;
  sortOrder: number;
  lectures: MktLectureDto[];
}

export interface MktStudioCourseDto {
  id: number;
  sellerId: number;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  categoryId: number | null;
  subcategoryId: number | null;
  level: MktCourseLevel;
  language: string;
  pricePaise: number;
  outcomes: string[];
  requirements: string[];
  audience: string[];
  thumbnail: MktMediaDto | null;
  promo: MktMediaDto | null;
  status: MktCourseStatus;
  reviewNote: string | null;
  submittedAt: string | null;
  publishedAt: string | null;
  enrolmentCount: number;
  lectureCount: number;
  durationSeconds: number;
  sections: MktSectionDto[];
  updatedAt: string;
  seller?: MktSellerRef;
}

export interface MktCourseInput {
  title: string;
  subtitle?: string | null;
  description?: string | null;
  categoryId?: number | null;
  subcategoryId?: number | null;
  level?: MktCourseLevel;
  language?: string;
  pricePaise?: number;
  outcomes?: string[];
  requirements?: string[];
  audience?: string[];
  thumbnailMediaId?: number | null;
  promoMediaId?: number | null;
}

export interface MktSectionInput {
  title: string;
}

export interface MktLectureInput {
  title: string;
  type: MktLectureType;
  description?: string | null;
  articleBody?: string | null;
  mediaId?: number | null;
  preview?: boolean;
  /** Articles and resources: the estimated reading time; videos take theirs from the media. */
  durationSeconds?: number | null;
}

/** What still blocks submitting the course for review. Empty = ready. */
export interface MktReadinessDto {
  ready: boolean;
  issues: string[];
}

// ---------------------------------------------------------------- cart & orders

export interface MktCartItemDto {
  course: MktCourseCardDto;
  /** Discount the applied coupon gives this course. */
  discountPaise: number;
}

export interface MktCartDto {
  items: MktCartItemDto[];
  couponCode: string | null;
  /** Why the coupon doesn't apply (expired, other seller…); null when it does or there is none. */
  couponMessage: string | null;
  subtotalPaise: number;
  discountPaise: number;
  totalPaise: number;
}

export interface MktCheckoutDto {
  orderId: number;
  number: string;
  status: MktOrderStatus;
  amountPaise: number;
  /** Null for a free order (enrolled at once). */
  payment: {
    paymentId: number;
    gateway: PaymentGatewayKey;
    gatewayOrderId: string;
    checkout: Record<string, unknown>;
  } | null;
}

export interface MktOrderItemDto {
  courseId: number;
  title: string;
  slug: string;
  sellerName: string;
  pricePaise: number;
  discountPaise: number;
  paidPaise: number;
}

export interface MktOrderDto {
  id: number;
  number: string;
  status: MktOrderStatus;
  gateway: string | null;
  gatewayPaymentId: string | null;
  couponCode: string | null;
  subtotalPaise: number;
  discountPaise: number;
  totalPaise: number;
  items: MktOrderItemDto[];
  buyer: { name: string; mobile: string | null; email: string | null };
  createdAt: string;
  paidAt: string | null;
}

// ---------------------------------------------------------------- learning

export interface MktEnrolmentDto {
  course: MktCourseCardDto;
  progressPercent: number;
  completedLectures: number;
  lastLectureId: number | null;
  lastAccessedAt: string | null;
  completedAt: string | null;
  enrolledAt: string;
}

export interface MktPlayerLectureDto extends MktLectureOutlineDto {
  completed: boolean;
  positionSeconds: number;
}

export interface MktPlayerDto {
  course: MktCourseCardDto;
  sections: { id: number; title: string; lectures: MktPlayerLectureDto[] }[];
  progressPercent: number;
  lastLectureId: number | null;
}

export interface MktLectureContentDto {
  id: number;
  title: string;
  type: MktLectureType;
  description: string | null;
  articleBody: string | null;
  stream: MktStreamDto | null;
  /** Signed download of a resource lecture. */
  download: { url: string; name: string; sizeBytes: number } | null;
  positionSeconds: number;
  completed: boolean;
}

export interface MktProgressInput {
  positionSeconds?: number;
  completed?: boolean;
}

export interface MktProgressDto {
  lectureId: number;
  completed: boolean;
  positionSeconds: number;
  progressPercent: number;
}

// ---------------------------------------------------------------- sellers, coupons, settings, ledger

export interface MktSellerAdminDto extends MktSellerRef {
  headline: string | null;
  bio: string | null;
  website: string | null;
  status: MktSellerStatus;
  instituteId: number | null;
  /** Commission override for this seller; null = the platform default. */
  commissionPercent: number | null;
  courseCount: number;
  createdAt: string;
}

export interface MktCouponDto {
  id: number;
  code: string;
  /** null = platform coupon (any seller's courses). */
  sellerId: number | null;
  kind: MktCouponKind;
  /** Percent (1-100) or paise off each course. */
  value: number;
  /** Limits the coupon to these courses; empty = every course in scope. */
  courseIds: number[];
  maxUses: number | null;
  usedCount: number;
  validFrom: string | null;
  validUntil: string | null;
  active: boolean;
}

export interface MktCouponInput {
  code: string;
  kind: MktCouponKind;
  value: number;
  courseIds?: number[];
  maxUses?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  active?: boolean;
}

export interface MktSettingsDto {
  /** Default platform commission on each sale, percent. */
  commissionPercent: number;
  /** Anyone may create an independent instructor profile. */
  instructorSignupOpen: boolean;
}

/** One course sold: what the buyer paid, the platform's commission and what the seller is owed. */
export interface MktLedgerEntryDto {
  id: number;
  orderId: number;
  orderNumber: string;
  courseId: number;
  courseTitle: string;
  seller: MktSellerRef;
  grossPaise: number;
  commissionPercent: number;
  commissionPaise: number;
  netPaise: number;
  /** Set once the payout covering this sale is made (payouts module). */
  payoutId: number | null;
  createdAt: string;
}

export interface MktReviewItemDto {
  course: MktStudioCourseDto;
  seller: MktSellerAdminDto;
}
