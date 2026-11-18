import { Op } from 'sequelize';
import { z } from 'zod';
import type { WebsiteSiteDto } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { webAppBaseUrl } from '../../shared/public-urls';
import { getContext, requireTenantContext, runWithContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { Branch } from '../branches/branch.model';
import { Institute } from '../institutes/institute.model';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { seoSchema } from './blocks';
import { cached, invalidateAllSites } from './cache';
import { WebsiteSite } from './models';

export const PUBLIC_PREFIX = '/api/public/sites';
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'app', 'admin', 'mail', 'static', 'cdn', 'public']);

const colour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB colour')
  .nullable()
  .optional();

export const siteInputSchema = z.object({
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Letters, digits and hyphens only')
    .refine((v) => !RESERVED_SUBDOMAINS.has(v), 'This subdomain is reserved')
    .nullable()
    .optional(),
  customDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      'Enter a domain like example.com',
    )
    .nullable()
    .optional(),
  theme: z
    .object({
      primaryColor: colour,
      secondaryColor: colour,
      font: z.enum(['system', 'serif', 'rounded']).optional(),
      footerText: z.string().trim().max(500).nullable().optional(),
      socialLinks: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(40),
            url: z
              .string()
              .trim()
              .url()
              .max(300)
              .regex(/^https?:\/\//i),
          }),
        )
        .max(10)
        .optional(),
    })
    .optional(),
  seo: seoSchema.extend({ indexable: z.boolean().optional() }).optional(),
  appUrl: z
    .string()
    .trim()
    .url()
    .max(255)
    .regex(/^https?:\/\//i)
    .nullable()
    .optional(),
  defaultBranchId: z.number().int().positive().nullable().optional(),
});

/** The institute's site row, created on first use. */
export async function getSite(): Promise<WebsiteSite> {
  const { instituteId } = requireTenantContext();
  const [site] = await WebsiteSite.findOrCreate({
    where: { instituteId },
    defaults: {
      instituteId,
      subdomain: null,
      customDomain: null,
      theme: {},
      seo: {},
      appUrl: null,
      defaultBranchId: null,
    },
  });
  return site;
}

export function siteBaseUrl(site: WebsiteSite, inst: Pick<Institute, 'slug'>) {
  if (site.customDomain) return `https://${site.customDomain}`;
  return `${config.API_PUBLIC_URL}${PUBLIC_PREFIX}/${inst.slug}`;
}

/** App URL used for the online admission (self-registration) link. */
export function appBaseUrl(site: WebsiteSite) {
  return webAppBaseUrl(site.appUrl);
}

export function admissionUrl(site: WebsiteSite, inst: Pick<Institute, 'slug'>, ref?: string | null) {
  const url = `${appBaseUrl(site)}/register/${encodeURIComponent(inst.slug)}`;
  return ref ? `${url}?ref=${encodeURIComponent(ref)}` : url;
}

export function toSiteDto(site: WebsiteSite, inst: Institute): WebsiteSiteDto {
  const base = siteBaseUrl(site, inst);
  return {
    subdomain: site.subdomain,
    customDomain: site.customDomain,
    theme: site.theme ?? {},
    seo: { ...(site.seo ?? {}), indexable: site.indexable },
    appUrl: site.appUrl,
    defaultBranchId: site.defaultBranchId,
    publicUrl: base,
    sitemapUrl: `${base}/sitemap.xml`,
    robotsUrl: `${base}/robots.txt`,
  };
}

export async function currentInstitute() {
  const inst = await Institute.findByPk(requireTenantContext().instituteId);
  if (!inst) throw NotFound('Institute');
  return inst;
}

export async function updateSite(input: z.infer<typeof siteInputSchema>) {
  const { instituteId } = requireTenantContext();
  const site = await getSite();
  // Subdomains and custom domains are globally unique across institutes, so the uniqueness check
  // must look at every tenant (tenantBypass); it only reads the id, never another tenant's data.
  for (const field of ['subdomain', 'customDomain'] as const) {
    const value = input[field];
    if (!value || value === site[field]) continue;
    const taken = await WebsiteSite.findOne({
      where: { [field]: value, instituteId: { [Op.ne]: instituteId } },
      attributes: ['id'],
      tenantBypass: true,
    } as never);
    if (taken) throw Conflict(`This ${field === 'subdomain' ? 'subdomain' : 'domain'} is already in use`);
  }
  if (input.defaultBranchId) {
    const branch = await Branch.findOne({ where: { instituteId, id: input.defaultBranchId } });
    if (!branch) throw BadRequest('Unknown branch');
  }
  const { seo, ...rest } = input;
  const values: Partial<WebsiteSite> = { ...(rest as Partial<WebsiteSite>) };
  if (seo) {
    const { indexable, ...seoRest } = seo;
    values.seo = { ...(site.seo ?? {}), ...seoRest };
    if (indexable !== undefined) values.indexable = indexable;
  }
  if (input.theme) values.theme = { ...(site.theme ?? {}), ...input.theme };
  const before = site.toJSON();
  await site.update(values);
  invalidateAllSites();
  return { site, before };
}

// ------------------------------------------------------------------ public resolution

export interface PublicSite {
  instituteId: number;
  slug: string;
  /** Path prefix for links in rendered HTML ('' when served on the institute's own host). */
  basePath: string;
}

/**
 * Resolves the institute for a public request. `key` is the institute slug; the special key
 * `_host` resolves from the request host instead: an exact custom-domain match, else the first
 * DNS label as the site subdomain (the platform proxies `*.<platform domain>` and mapped custom
 * domains to `/api/public/sites/_host/...`).
 */
export async function resolvePublicSite(key: string, host: string | undefined): Promise<PublicSite> {
  const resolved = await cached(0, `resolve:${key}:${key === '_host' ? (host ?? '') : ''}`, async () => {
    let inst: Institute | null = null;
    if (key === '_host') {
      const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
      // Public resolution has no tenant yet: look up the site by its globally unique domain.
      const site =
        (await WebsiteSite.findOne({ where: { customDomain: h }, tenantBypass: true } as never)) ??
        (await WebsiteSite.findOne({ where: { subdomain: h.split('.')[0] }, tenantBypass: true } as never));
      if (site) inst = await Institute.findByPk(site.instituteId);
    } else {
      inst = await Institute.findOne({ where: { slug: key.toLowerCase() } });
    }
    if (!inst || inst.status !== 'active' || !(await isModuleEnabled(inst.id, 'website'))) return null;
    return { instituteId: inst.id, slug: inst.slug };
  });
  if (!resolved) throw NotFound('Website');
  return { ...resolved, basePath: key === '_host' ? '' : `${PUBLIC_PREFIX}/${resolved.slug}` };
}

/**
 * Public routes have no authenticated tenant. Bind the context to the institute resolved from the
 * slug/host and mark it `system` so tenant-scoped services run for that institute only. Nothing
 * here accepts an institute id from the client.
 */
export function asInstitute<T>(instituteId: number, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ ...getContext(), system: true, instituteId, allowedBranchIds: null }, fn);
}
