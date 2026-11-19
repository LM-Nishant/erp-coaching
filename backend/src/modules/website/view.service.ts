/**
 * Builds the data and render options for a page, shared by the public site and the admin preview.
 */
import { Op } from 'sequelize';
import type { WebsiteBlock, WebsiteSeo } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { requireTenantContext } from '../../shared/context';
import { FileObject } from '../files/file.model';
import { signedUrlFor } from '../files/files.service';
import type { Institute } from '../institutes/institute.model';
import { cached } from './cache';
import { resolveBlocks, type ResolvedBlock } from './content.service';
import { WebsitePage, WebsitePageVersion, type WebsiteSite } from './models';
import { renderPage, type RenderOptions } from './render';
import { admissionUrl, appBaseUrl, currentInstitute, getSite, siteBaseUrl } from './site.service';

export interface LivePage {
  pageId: number;
  slug: string;
  title: string;
  isHome: boolean;
  showInNav: boolean;
  sortOrder: number;
  blocks: WebsiteBlock[];
  seo: WebsiteSeo | null;
  mediaFileIds: number[];
  publishedAt: Date;
}

export interface LiveSite {
  institute: {
    id: number;
    slug: string;
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
    secondaryColor: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  site: {
    theme: WebsiteSite['theme'];
    seo: WebsiteSeo;
    indexable: boolean;
    /** The verified custom domain (an unverified one isn't served). */
    customDomain: string | null;
    baseUrl: string;
    admissionUrl: string;
    /** Base URL of the institute app (purchase/registration pages live there). */
    appUrl: string;
    ogImageFileId: number | null;
  };
  pages: LivePage[];
}

function instituteInfo(inst: Institute): LiveSite['institute'] {
  const b = inst.toBranding();
  const address = [inst.address, inst.city, inst.state].filter(Boolean).join(', ') || null;
  return {
    id: inst.id,
    slug: inst.slug,
    name: inst.name,
    logoUrl: b.logoUrl,
    primaryColor: inst.primaryColor,
    secondaryColor: inst.secondaryColor,
    address,
    phone: inst.contactPhone ?? null,
    email: inst.contactEmail ?? null,
  };
}

/** Published snapshot of the current institute's site (cached; invalidated on publish/settings). */
export function loadLiveSite(): Promise<LiveSite> {
  const { instituteId } = requireTenantContext();
  return cached(instituteId, 'live', async () => {
    const [inst, site] = await Promise.all([currentInstitute(), getSite()]);
    const pages = await WebsitePage.findAll({
      where: { instituteId, publishedVersionId: { [Op.ne]: null } },
      include: [{ model: WebsitePageVersion, as: 'publishedVersion', required: true }],
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const base = siteBaseUrl(site, inst);
    return {
      institute: instituteInfo(inst),
      site: {
        theme: site.theme ?? {},
        seo: site.seo ?? {},
        indexable: site.indexable,
        customDomain: site.verifiedDomain,
        baseUrl: base,
        admissionUrl: admissionUrl(site, inst),
        appUrl: appBaseUrl(site),
        ogImageFileId: site.seo?.ogImageFileId ?? null,
      },
      pages: pages.map((p) => {
        const v = p.publishedVersion!;
        return {
          pageId: p.id,
          slug: p.slug,
          title: v.title,
          isHome: p.isHome,
          showInNav: p.showInNav,
          sortOrder: p.sortOrder,
          blocks: v.blocks ?? [],
          seo: v.seo,
          mediaFileIds: v.mediaFileIds ?? [],
          publishedAt: v.publishedAt,
        };
      }),
    };
  });
}

export function homePage(live: LiveSite) {
  return live.pages.find((p) => p.isHome) ?? live.pages[0] ?? null;
}

export function findLivePage(live: LiveSite, slug: string) {
  return live.pages.find((p) => p.slug === slug.toLowerCase()) ?? null;
}

/** Files the public site may serve: media of live versions plus the site OG image. */
export function publicMediaIds(live: LiveSite) {
  const ids = new Set<number>(live.pages.flatMap((p) => p.mediaFileIds));
  if (live.site.ogImageFileId) ids.add(live.site.ogImageFileId);
  return ids;
}

function pagePath(basePath: string, p: { slug: string; isHome: boolean }) {
  return p.isHome ? `${basePath}/` : `${basePath}/p/${encodeURIComponent(p.slug)}`;
}

function withRef(url: string, ref: string | null) {
  if (!ref) return url;
  const [path, hash] = url.split('#');
  return `${path}${path.includes('?') ? '&' : '?'}ref=${encodeURIComponent(ref)}${hash !== undefined ? `#${hash}` : ''}`;
}

export interface ViewInput {
  live: LiveSite;
  page: { slug: string; title: string; isHome: boolean; seo: WebsiteSeo | null; blocks: WebsiteBlock[] };
  basePath: string;
  ref: string | null;
  preview: boolean;
  flash?: RenderOptions['flash'];
  /** Media URL override (admin preview uses signed URLs for unpublished images). */
  mediaUrl?: (fileId: number) => string;
}

export async function buildView(input: ViewInput) {
  const { live, page, basePath, ref } = input;
  const blocks: ResolvedBlock[] = await resolveBlocks(page.blocks);
  const isHomeHref = (slug: string) => live.pages.find((p) => p.slug === slug)?.isHome ?? false;
  const resolveHref = (href: string): string => {
    if (href === 'admission') return withRef(live.site.admissionUrl, ref);
    if (href === 'enquiry') return '#enquiry';
    if (href.startsWith('page:')) {
      const slug = href.slice(5);
      return withRef(pagePath(basePath, { slug, isHome: isHomeHref(slug) }), ref);
    }
    if (href.startsWith('checkout:'))
      return withRef(`${basePath}/checkout/${encodeURIComponent(href.slice(9))}`, ref);
    return href;
  };
  const mediaUrl = input.mediaUrl ?? ((id: number) => `${basePath}/media/${id}`);
  const options: RenderOptions = {
    institute: live.institute,
    theme: live.site.theme ?? {},
    page: { slug: page.slug, title: page.title, seo: page.seo, isHome: page.isHome },
    siteSeo: live.site.seo,
    indexable: live.site.indexable,
    canonicalUrl: page.isHome
      ? `${live.site.baseUrl}/`
      : `${live.site.baseUrl}/p/${encodeURIComponent(page.slug)}`,
    basePath,
    nav: live.pages
      .filter((p) => p.showInNav)
      .map((p) => ({
        title: p.title,
        href: withRef(pagePath(basePath, p), ref),
        active: p.slug === page.slug,
      })),
    mediaUrl,
    absoluteMediaUrl: (id) => (input.mediaUrl ? input.mediaUrl(id) : `${live.site.baseUrl}/media/${id}`),
    resolveHref,
    checkoutHref: (courseId) => withRef(`${basePath}/checkout/${courseId}`, ref),
    ref,
    preview: input.preview,
    flash: input.flash ?? null,
    contact: { address: live.institute.address, phone: live.institute.phone, email: live.institute.email },
  };
  return { blocks, options, html: renderPage(blocks, options) };
}

/** Signed URLs for every image of a draft (admin preview). */
export async function signedMediaResolver(ids: number[]) {
  const { instituteId } = requireTenantContext();
  const files = ids.length ? await FileObject.findAll({ where: { instituteId, id: { [Op.in]: ids } } }) : [];
  const urls = new Map(files.map((f) => [f.id, signedUrlFor(f).url]));
  return (id: number) => urls.get(id) ?? `${config.API_PUBLIC_URL}/missing-image`;
}
