import type {
  MktAccountDto,
  MktCartDto,
  MktCatalogQuery,
  MktCategoryDto,
  MktCheckoutDto,
  MktCouponDto,
  MktCouponInput,
  MktCourseCardDto,
  MktCourseDetailDto,
  MktCourseInput,
  MktEnrolmentDto,
  MktHomeDto,
  MktInstructorProfileInput,
  MktLectureContentDto,
  MktLectureInput,
  MktLedgerEntryDto,
  MktMediaDto,
  MktMediaKind,
  MktOrderDto,
  MktPage,
  MktPlayerDto,
  MktProgressDto,
  MktProgressInput,
  MktReadinessDto,
  MktReviewItemDto,
  MktSellerAdminDto,
  MktSellerPublicDto,
  MktSettingsDto,
  MktSignupInput,
  MktStreamDto,
  MktStudioCourseDto,
  CheckoutReturnInput,
  MktCourseStatus,
} from '@erp/shared';
import { MKT_LANGUAGES, MKT_UPLOAD_CHUNK_BYTES } from '@erp/shared';
import { API_URL, ApiError, api } from '@/core/api';
import { loadSession } from '@/core/token-storage';

export { rupees } from '../hr/api';

/** Which storefront the course builder works on: the user's own instructor profile or their institute's. */
export type StudioScope = 'instructor' | 'institute';

export const priceLabel = (c: { isFree: boolean; pricePaise: number }) =>
  c.isFree || c.pricePaise === 0 ? 'Free' : `₹${(c.pricePaise / 100).toLocaleString('en-IN')}`;

export const languageLabel = (code: string) =>
  (MKT_LANGUAGES as Record<string, string>)[code] ?? code.toUpperCase();

export function durationLabel(seconds: number) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return m ? `${m} min` : `${seconds} s`;
}

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const anon = { anonymous: true };
type Q = Record<string, string | number | boolean | null | undefined>;

export const marketApi = {
  // catalog (no sign-in needed)
  home: () => api.get<MktHomeDto>('/marketplace/public/home', undefined, anon),
  categories: () => api.get<MktCategoryDto[]>('/marketplace/public/categories', undefined, anon),
  search: (q: MktCatalogQuery) =>
    api.get<MktPage<MktCourseCardDto>>('/marketplace/public/courses', q as Q, anon),
  course: (slug: string) =>
    api.get<MktCourseDetailDto>(`/marketplace/public/courses/${encodeURIComponent(slug)}`, undefined, anon),
  instructor: (slug: string) =>
    api.get<MktSellerPublicDto>(
      `/marketplace/public/instructors/${encodeURIComponent(slug)}`,
      undefined,
      anon,
    ),
  preview: (lectureId: number) =>
    api.get<{
      id: number;
      title: string;
      type: string;
      articleBody: string | null;
      stream: MktStreamDto | null;
    }>(`/marketplace/public/lectures/${lectureId}/preview`, undefined, anon),
  signup: (input: MktSignupInput) =>
    api.post<{ id: number; name: string }>('/marketplace/public/signup', input, anon),

  // learner
  account: () => api.get<MktAccountDto>('/marketplace/account'),
  saveInstructorProfile: (input: MktInstructorProfileInput) =>
    api.put<MktSellerAdminDto>('/marketplace/instructor-profile', input),
  access: (courseId: number) =>
    api.get<{ enrolled: boolean; inCart: boolean }>(`/marketplace/courses/${courseId}/access`),
  enrolFree: (courseId: number) => api.post<MktEnrolmentDto>(`/marketplace/courses/${courseId}/enrol`),
  cart: (coupon?: string) => api.get<MktCartDto>('/marketplace/cart', { coupon: coupon || undefined }),
  addToCart: (courseId: number) => api.post<MktCartDto>('/marketplace/cart/items', { courseId }),
  removeFromCart: (courseId: number) => api.delete<MktCartDto>(`/marketplace/cart/items/${courseId}`),
  checkout: (body: {
    courseIds?: number[];
    couponCode?: string | null;
    returnTo?: CheckoutReturnInput | null;
  }) =>
    api.post<MktCheckoutDto>('/marketplace/checkout', body, {
      headers: { 'Idempotency-Key': `mkt-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    }),
  orders: () => api.get<MktOrderDto[]>('/marketplace/orders'),
  order: (id: number) => api.get<MktOrderDto>(`/marketplace/orders/${id}`),
  syncOrder: (id: number) => api.post<MktOrderDto>(`/marketplace/orders/${id}/sync`),
  mockComplete: (id: number, outcome: 'success' | 'failed') =>
    api.post<{ outcome: string; order: MktOrderDto }>(`/marketplace/orders/${id}/mock-complete`, { outcome }),
  myLearning: () => api.get<MktEnrolmentDto[]>('/marketplace/learning'),
  player: (courseId: number) => api.get<MktPlayerDto>(`/marketplace/learning/${courseId}`),
  lecture: (courseId: number, lectureId: number) =>
    api.get<MktLectureContentDto>(`/marketplace/learning/${courseId}/lectures/${lectureId}`),
  progress: (courseId: number, lectureId: number, body: MktProgressInput, background = false) =>
    api.put<MktProgressDto>(`/marketplace/learning/${courseId}/lectures/${lectureId}/progress`, body, {
      background,
    }),
};

/** Course builder calls for one storefront. */
export function studioApi(scope: StudioScope) {
  const base = `/marketplace/${scope}`;
  return {
    profile: () => api.get<MktSellerAdminDto>(`${base}/profile`),
    saveProfile: (input: MktInstructorProfileInput) => api.put<MktSellerAdminDto>(`${base}/profile`, input),
    courses: () => api.get<MktStudioCourseDto[]>(`${base}/courses`),
    course: (id: number) => api.get<MktStudioCourseDto>(`${base}/courses/${id}`),
    createCourse: (input: MktCourseInput) => api.post<MktStudioCourseDto>(`${base}/courses`, input),
    updateCourse: (id: number, input: Partial<MktCourseInput>) =>
      api.patch<MktStudioCourseDto>(`${base}/courses/${id}`, input),
    deleteCourse: (id: number) => api.delete(`${base}/courses/${id}`),
    readiness: (id: number) => api.get<MktReadinessDto>(`${base}/courses/${id}/readiness`),
    submit: (id: number) => api.post<MktStudioCourseDto>(`${base}/courses/${id}/submit`),
    unpublish: (id: number) => api.post<MktStudioCourseDto>(`${base}/courses/${id}/unpublish`),
    reorder: (id: number, sections: { id: number; lectureIds: number[] }[]) =>
      api.put<MktStudioCourseDto>(`${base}/courses/${id}/curriculum-order`, { sections }),
    addSection: (id: number, title: string) =>
      api.post<MktStudioCourseDto>(`${base}/courses/${id}/sections`, { title }),
    renameSection: (id: number, sectionId: number, title: string) =>
      api.patch<MktStudioCourseDto>(`${base}/courses/${id}/sections/${sectionId}`, { title }),
    deleteSection: (id: number, sectionId: number) =>
      api.delete<MktStudioCourseDto>(`${base}/courses/${id}/sections/${sectionId}`),
    addLecture: (id: number, sectionId: number, input: MktLectureInput) =>
      api.post<MktStudioCourseDto>(`${base}/courses/${id}/sections/${sectionId}/lectures`, input),
    updateLecture: (id: number, lectureId: number, input: Partial<MktLectureInput>) =>
      api.patch<MktStudioCourseDto>(`${base}/courses/${id}/lectures/${lectureId}`, input),
    deleteLecture: (id: number, lectureId: number) =>
      api.delete<MktStudioCourseDto>(`${base}/courses/${id}/lectures/${lectureId}`),
    lectureContent: (id: number, lectureId: number) =>
      api.get<MktLectureContentDto>(`${base}/courses/${id}/lectures/${lectureId}/content`),
    media: (id: number) => api.get<MktMediaDto>(`${base}/media/${id}`),
    coupons: () => api.get<MktCouponDto[]>(`${base}/coupons`),
    createCoupon: (input: MktCouponInput) => api.post<MktCouponDto>(`${base}/coupons`, input),
    updateCoupon: (id: number, input: Partial<MktCouponInput>) =>
      api.patch<MktCouponDto>(`${base}/coupons/${id}`, input),
    deleteCoupon: (id: number) => api.delete(`${base}/coupons/${id}`),
    sales: (page = 1) => api.get<LedgerPage>(`${base}/sales`, { page }),
    /** Uploads `file` in chunks; `onProgress` gets the share sent (0-1). */
    upload: (
      file: File,
      kind: MktMediaKind,
      onProgress?: (share: number) => void,
      durationSeconds?: number,
    ) => uploadMedia(base, file, kind, onProgress, durationSeconds),
  };
}

export type LedgerPage = MktPage<MktLedgerEntryDto> & {
  totals: { grossPaise: number; commissionPaise: number; netPaise: number };
};

async function uploadMedia(
  base: string,
  file: File,
  kind: MktMediaKind,
  onProgress?: (share: number) => void,
  durationSeconds?: number,
): Promise<MktMediaDto> {
  let media = await api.post<MktMediaDto>(`${base}/media`, {
    kind,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    durationSeconds: durationSeconds ? Math.round(durationSeconds) : null,
  });
  let offset = 0;
  onProgress?.(0);
  while (offset < file.size) {
    const end = Math.min(offset + MKT_UPLOAD_CHUNK_BYTES, file.size);
    const session = await loadSession();
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      Accept: 'application/json',
    };
    if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
    if (session?.branchId) headers['X-Branch-Id'] = String(session.branchId);
    const res = await fetch(`${API_URL}/api${base}/media/${media.id}/content?offset=${offset}`, {
      method: 'PUT',
      headers,
      body: file.slice(offset, end),
    });
    const body = (await res.json().catch(() => ({}))) as MktMediaDto & { error?: { message?: string } };
    if (!res.ok)
      throw new ApiError(res.status, 'UPLOAD_FAILED', body.error?.message ?? 'The upload failed. Try again.');
    media = body;
    offset = media.receivedBytes || end;
    onProgress?.(offset / file.size);
  }
  return media;
}

/** Reads a video file's length in the browser, so the lecture shows it before transcoding. */
export function videoDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    const done = (d?: number) => {
      URL.revokeObjectURL(url);
      resolve(d && Number.isFinite(d) ? d : undefined);
    };
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done();
    v.src = url;
  });
}

export const adminMarketApi = {
  queue: (status: MktCourseStatus = 'in_review') =>
    api.get<MktReviewItemDto[]>('/admin/marketplace/courses', { status }),
  course: (id: number) =>
    api.get<MktReviewItemDto & { issues: string[] }>(`/admin/marketplace/courses/${id}`),
  lecture: (id: number, lectureId: number) =>
    api.get<MktLectureContentDto>(`/admin/marketplace/courses/${id}/lectures/${lectureId}`),
  approve: (id: number, note?: string) =>
    api.post<MktStudioCourseDto>(`/admin/marketplace/courses/${id}/approve`, { note: note || null }),
  reject: (id: number, reason: string) =>
    api.post<MktStudioCourseDto>(`/admin/marketplace/courses/${id}/reject`, { reason }),
  publish: (id: number) => api.post<MktStudioCourseDto>(`/admin/marketplace/courses/${id}/publish`),
  unpublish: (id: number, reason?: string) =>
    api.post<MktStudioCourseDto>(`/admin/marketplace/courses/${id}/unpublish`, { reason: reason || null }),
  saveCategory: (
    id: number | null,
    input: {
      name: string;
      slug?: string;
      parentId?: number | null;
      icon?: string | null;
      sortOrder?: number;
    },
  ) =>
    id
      ? api.put<MktCategoryDto[]>(`/admin/marketplace/categories/${id}`, input)
      : api.post<MktCategoryDto[]>('/admin/marketplace/categories', input),
  deleteCategory: (id: number) => api.delete<MktCategoryDto[]>(`/admin/marketplace/categories/${id}`),
  settings: () => api.get<MktSettingsDto>('/admin/marketplace/settings'),
  saveSettings: (input: Partial<MktSettingsDto>) =>
    api.put<MktSettingsDto>('/admin/marketplace/settings', input),
  sellers: (q?: { q?: string; type?: string }) =>
    api.get<MktSellerAdminDto[]>('/admin/marketplace/sellers', q),
  updateSeller: (id: number, input: { status?: string; commissionPercent?: number | null }) =>
    api.patch<MktSellerAdminDto>(`/admin/marketplace/sellers/${id}`, input),
  coupons: () => api.get<MktCouponDto[]>('/admin/marketplace/coupons'),
  createCoupon: (input: MktCouponInput) => api.post<MktCouponDto>('/admin/marketplace/coupons', input),
  updateCoupon: (id: number, input: Partial<MktCouponInput>) =>
    api.patch<MktCouponDto>(`/admin/marketplace/coupons/${id}`, input),
  deleteCoupon: (id: number) => api.delete(`/admin/marketplace/coupons/${id}`),
  ledger: (q: { sellerId?: number; page?: number } = {}) =>
    api.get<LedgerPage>('/admin/marketplace/ledger', q),
};
