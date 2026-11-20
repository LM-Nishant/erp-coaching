import type {
  CouponDto,
  CouponInput,
  CouponValidationResult,
  Paginated,
  ReferralCodeDto,
  ReferralCodeInput,
  ReferralEventDto,
  ReferralEventKind,
  WebsiteAnnouncementDto,
  WebsitePageDto,
  WebsitePageInput,
  WebsitePageSummaryDto,
  WebsitePageVersionDto,
  WebsiteSiteDto,
  WebsiteSiteInput,
} from '@erp/shared';
import { api } from '@/core/api';

export interface CouponRedemptionDto {
  id: number;
  orderRef: string;
  customerKey: string | null;
  amountPaise: number;
  discountPaise: number;
  status: string;
  createdAt: string;
}

export type AnnouncementInput = Partial<Omit<WebsiteAnnouncementDto, 'id'>>;

type Q = Record<string, string | number | boolean | undefined | null>;
const W = '/website';

export const websiteApi = {
  site: () => api.get<WebsiteSiteDto>(`${W}/site`),
  saveSite: (b: WebsiteSiteInput) => api.patch<WebsiteSiteDto>(`${W}/site`, b),
  verifyDomain: () => api.post<WebsiteSiteDto>(`${W}/site/domain/verify`),

  pages: () => api.get<WebsitePageSummaryDto[]>(`${W}/pages`),
  page: (id: number) => api.get<WebsitePageDto>(`${W}/pages/${id}`),
  createPage: (b: WebsitePageInput) => api.post<WebsitePageDto>(`${W}/pages`, b),
  updatePage: (id: number, b: WebsitePageInput) => api.patch<WebsitePageDto>(`${W}/pages/${id}`, b),
  removePage: (id: number) => api.delete(`${W}/pages/${id}`),
  publish: (id: number) => api.post<WebsitePageDto>(`${W}/pages/${id}/publish`),
  unpublish: (id: number) => api.post<WebsitePageDto>(`${W}/pages/${id}/unpublish`),
  versions: (id: number) => api.get<WebsitePageVersionDto[]>(`${W}/pages/${id}/versions`),
  restore: (id: number, versionId: number) =>
    api.post<WebsitePageDto>(`${W}/pages/${id}/versions/${versionId}/restore`),
  preview: (id: number) => api.get<{ html: string }>(`${W}/pages/${id}/preview`),

  announcements: (q: Q = {}) =>
    api.get<Paginated<WebsiteAnnouncementDto>>(`${W}/announcements`, { pageSize: 100, ...q }),
  saveAnnouncement: (id: number | null, b: AnnouncementInput) =>
    id
      ? api.patch<WebsiteAnnouncementDto>(`${W}/announcements/${id}`, b)
      : api.post<WebsiteAnnouncementDto>(`${W}/announcements`, b),
  removeAnnouncement: (id: number) => api.delete(`${W}/announcements/${id}`),

  coupons: (q: Q = {}) => api.get<Paginated<CouponDto>>(`${W}/coupons`, { pageSize: 100, ...q }),
  saveCoupon: (id: number | null, b: CouponInput) =>
    id ? api.patch<CouponDto>(`${W}/coupons/${id}`, b) : api.post<CouponDto>(`${W}/coupons`, b),
  removeCoupon: (id: number) => api.delete(`${W}/coupons/${id}`),
  validateCoupon: (b: {
    code: string;
    amountPaise: number;
    courseId?: number | null;
    customerKey?: string;
  }) => api.post<CouponValidationResult>(`${W}/coupons/validate`, b),
  redemptions: (id: number, q: Q = {}) =>
    api.get<Paginated<CouponRedemptionDto>>(`${W}/coupons/${id}/redemptions`, { pageSize: 50, ...q }),

  referrals: (q: Q = {}) => api.get<Paginated<ReferralCodeDto>>(`${W}/referrals`, { pageSize: 100, ...q }),
  saveReferral: (id: number | null, b: ReferralCodeInput) =>
    id
      ? api.patch<ReferralCodeDto>(`${W}/referrals/${id}`, b)
      : api.post<ReferralCodeDto>(`${W}/referrals`, b),
  removeReferral: (id: number) => api.delete(`${W}/referrals/${id}`),
  referralEvents: (id: number, kind?: ReferralEventKind) =>
    api.get<Paginated<ReferralEventDto>>(`${W}/referrals/${id}/events`, { pageSize: 50, kind }),

  upload: (file: File) => api.upload(file, { module: 'website' }),
};

export interface NamedRef {
  id: number;
  name: string;
}
