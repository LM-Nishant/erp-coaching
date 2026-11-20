/** Website builder & online admissions (spec §4.13). */

export const WEBSITE_BLOCK_TYPES = [
  'hero',
  'text',
  'image',
  'gallery',
  'courses',
  'batches',
  'faculty',
  'testimonials',
  'announcements',
  'enquiry_form',
  'demo_form',
  'contact',
  'cta',
] as const;
export type WebsiteBlockType = (typeof WEBSITE_BLOCK_TYPES)[number];

export const WEBSITE_BLOCK_LABELS: Record<WebsiteBlockType, string> = {
  hero: 'Hero banner',
  text: 'Rich text',
  image: 'Image',
  gallery: 'Gallery',
  courses: 'Course list',
  batches: 'Batch list',
  faculty: 'Faculty',
  testimonials: 'Testimonials',
  announcements: 'Announcements',
  enquiry_form: 'Enquiry form',
  demo_form: 'Demo-class registration',
  contact: 'Contact & map',
  cta: 'Call to action',
};

/**
 * Link targets used by buttons: `/path`, `#anchor`, `https://…`, `mailto:`, `tel:`, or the special
 * tokens `page:<slug>`, `admission` (online self-registration) and `checkout:<courseId>`
 * (online purchase handoff to fees/payments).
 */
export type WebsiteHref = string;

export interface HeroSettings {
  heading: string;
  subheading?: string | null;
  imageFileId?: number | null;
  ctaLabel?: string | null;
  ctaHref?: WebsiteHref | null;
}
/** `body` is a Markdown subset: paragraphs, `- ` lists, `## ` headings, **bold**, *italic*, [text](url). */
export interface TextSettings {
  heading?: string | null;
  body: string;
}
export interface ImageSettings {
  fileId: number;
  alt?: string | null;
  caption?: string | null;
  href?: WebsiteHref | null;
}
export interface GallerySettings {
  heading?: string | null;
  images: { fileId: number; caption?: string | null }[];
}
export interface CoursesSettings {
  heading?: string | null;
  /** null/empty = every active, non-template course. */
  courseIds?: number[] | null;
  showDescription?: boolean;
  /** Show a "Buy / Enrol online" button that hands off to checkout. */
  showBuyButton?: boolean;
}
export interface BatchesSettings {
  heading?: string | null;
  courseId?: number | null;
  branchId?: number | null;
  /** Only batches that have not ended (default true). */
  upcomingOnly?: boolean;
  limit?: number;
}
export interface FacultyMember {
  name: string;
  subject?: string | null;
  bio?: string | null;
  photoFileId?: number | null;
}
export interface FacultySettings {
  heading?: string | null;
  members: FacultyMember[];
}
export interface TestimonialsSettings {
  heading?: string | null;
  items: { name: string; role?: string | null; quote: string; photoFileId?: number | null }[];
}
export interface AnnouncementsSettings {
  heading?: string | null;
  limit?: number;
}
export interface EnquiryFormSettings {
  heading?: string | null;
  intro?: string | null;
  branchId?: number | null;
  submitLabel?: string | null;
  successMessage?: string | null;
}
export interface DemoFormSettings {
  heading?: string | null;
  intro?: string | null;
  courseId?: number | null;
  branchId?: number | null;
  /** Offered demo sessions; the visitor picks one. Empty = free-text preferred date. */
  slots: { label: string; startsAt?: string | null }[];
  submitLabel?: string | null;
  successMessage?: string | null;
}
export interface ContactSettings {
  heading?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Free-text map location; rendered as an embedded map. */
  mapQuery?: string | null;
}
export interface CtaSettings {
  heading: string;
  text?: string | null;
  buttonLabel: string;
  buttonHref: WebsiteHref;
}

export interface WebsiteBlockSettingsMap {
  hero: HeroSettings;
  text: TextSettings;
  image: ImageSettings;
  gallery: GallerySettings;
  courses: CoursesSettings;
  batches: BatchesSettings;
  faculty: FacultySettings;
  testimonials: TestimonialsSettings;
  announcements: AnnouncementsSettings;
  enquiry_form: EnquiryFormSettings;
  demo_form: DemoFormSettings;
  contact: ContactSettings;
  cta: CtaSettings;
}

export type WebsiteBlock = {
  [K in WebsiteBlockType]: { id: string; type: K; hidden?: boolean; settings: WebsiteBlockSettingsMap[K] };
}[WebsiteBlockType];

export interface WebsiteSeo {
  title?: string | null;
  description?: string | null;
  ogImageFileId?: number | null;
}

export interface WebsiteTheme {
  /** Overrides the institute branding colours when set. */
  primaryColor?: string | null;
  secondaryColor?: string | null;
  font?: 'system' | 'serif' | 'rounded';
  footerText?: string | null;
  socialLinks?: { label: string; url: string }[];
}

/** DNS TXT record proving the institute owns its custom domain. */
export interface WebsiteDomainVerificationDto {
  recordName: string;
  recordValue: string;
  /** Null until verified; an unverified domain isn't served. */
  verifiedAt: string | null;
}

export interface WebsiteSiteDto {
  subdomain: string | null;
  customDomain: string | null;
  /** Set when `customDomain` is. */
  domainVerification: WebsiteDomainVerificationDto | null;
  theme: WebsiteTheme;
  seo: WebsiteSeo & { indexable: boolean };
  /** App base URL used for online admission links (`<appUrl>/register/<slug>`). */
  appUrl: string | null;
  defaultBranchId: number | null;
  /** Public URL of the site (the custom domain once verified, otherwise the API slug route). */
  publicUrl: string;
  sitemapUrl: string;
  robotsUrl: string;
}

export interface WebsiteSiteInput {
  subdomain?: string | null;
  customDomain?: string | null;
  theme?: WebsiteTheme;
  seo?: WebsiteSeo & { indexable?: boolean };
  appUrl?: string | null;
  defaultBranchId?: number | null;
}

export type WebsitePageStatus = 'draft' | 'published' | 'changed';

export interface WebsitePageSummaryDto {
  id: number;
  slug: string;
  title: string;
  isHome: boolean;
  showInNav: boolean;
  sortOrder: number;
  status: WebsitePageStatus;
  publishedVersion: number | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface WebsitePageDto extends WebsitePageSummaryDto {
  blocks: WebsiteBlock[];
  seo: WebsiteSeo;
}

export interface WebsitePageInput {
  slug?: string;
  title?: string;
  isHome?: boolean;
  showInNav?: boolean;
  sortOrder?: number;
  blocks?: WebsiteBlock[];
  seo?: WebsiteSeo;
}

export interface WebsitePageVersionDto {
  id: number;
  version: number;
  title: string;
  publishedAt: string;
  publishedByName: string | null;
  isLive: boolean;
}

export interface WebsiteAnnouncementDto {
  id: number;
  title: string;
  body: string | null;
  linkUrl: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isPinned: boolean;
  isPublished: boolean;
}

export type CouponDiscountType = 'percent' | 'fixed';

export interface CouponDto {
  id: number;
  code: string;
  description: string | null;
  discountType: CouponDiscountType;
  /** Percent (0–100) or rupees, depending on `discountType`. */
  discountValue: number;
  /** Cap for percent coupons, in rupees. */
  maxDiscount: number | null;
  minAmount: number | null;
  validFrom: string | null;
  validUntil: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  /** null = all courses. */
  courseIds: number[] | null;
  isActive: boolean;
}

export type CouponInput = Partial<Omit<CouponDto, 'id' | 'usedCount'>> & { code?: string };

export interface CouponValidationResult {
  valid: boolean;
  code: string;
  couponId: number | null;
  /** Machine-readable reason when invalid. */
  reason:
    | null
    | 'NOT_FOUND'
    | 'INACTIVE'
    | 'NOT_STARTED'
    | 'EXPIRED'
    | 'USAGE_LIMIT'
    | 'CUSTOMER_LIMIT'
    | 'MIN_AMOUNT'
    | 'COURSE_NOT_ELIGIBLE';
  message: string;
  discountPaise: number;
  finalAmountPaise: number;
}

export type ReferralEventKind = 'click' | 'signup' | 'purchase';

export interface ReferralCodeDto {
  id: number;
  code: string;
  name: string;
  referrerUserId: number | null;
  referrerName: string | null;
  commissionNote: string | null;
  isActive: boolean;
  clicks: number;
  signups: number;
  purchases: number;
  /** Shareable link to the public site with this code. */
  shareUrl: string;
}

export interface ReferralCodeInput {
  code?: string;
  name?: string;
  referrerUserId?: number | null;
  commissionNote?: string | null;
  isActive?: boolean;
}

export interface ReferralEventDto {
  id: number;
  kind: ReferralEventKind;
  refType: string | null;
  refId: string | null;
  amountPaise: number | null;
  createdAt: string;
}

export interface PublicCheckoutResult {
  /** Where to send the visitor: the fees/payments checkout, or the online admission page. */
  url: string;
  handler: 'fees' | 'admission';
}

export interface PublicFormResult {
  ok: true;
  enquiryId: number;
  message: string;
}
