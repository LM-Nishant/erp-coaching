import { Op } from 'sequelize';
import { z } from 'zod';
import type {
  WebsiteBlock,
  WebsitePageDto,
  WebsitePageSummaryDto,
  WebsitePageVersionDto,
  WebsiteSeo,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { FileObject } from '../files/file.model';
import { User } from '../users/user.model';
import { blocksSchema, collectMediaFileIds, seoSchema } from './blocks';
import { invalidateSite } from './cache';
import { WebsitePage, WebsitePageVersion } from './models';

export const pageRepo = new TenantRepository(WebsitePage, { entity: 'Page' });
export const versionRepo = new TenantRepository(WebsitePageVersion, { entity: 'Page version' });

export const pageSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/, 'Use lowercase letters, digits and hyphens');

export const pageInputSchema = z.object({
  slug: pageSlug,
  title: z.string().trim().min(1).max(150),
  isHome: z.boolean().optional(),
  showInNav: z.boolean().optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
  blocks: blocksSchema.optional(),
  seo: seoSchema.nullable().optional(),
});

/** Every file the page references must be an image of this institute. */
export async function assertMediaOwned(blocks: WebsiteBlock[], seo?: WebsiteSeo | null) {
  const ids = collectMediaFileIds(blocks, seo);
  if (!ids.length) return;
  const { instituteId } = requireTenantContext();
  const files = await FileObject.findAll({
    where: { instituteId, id: { [Op.in]: ids } },
    attributes: ['id', 'mimeType'],
  });
  const ok = new Set(files.filter((f) => f.mimeType.startsWith('image/')).map((f) => f.id));
  const bad = ids.filter((id) => !ok.has(id));
  if (bad.length) throw BadRequest(`Images must be uploaded to this institute (file ${bad.join(', ')})`);
}

export async function assertSlugFree(slug: string, exceptId?: number) {
  const where: Record<string | symbol, unknown> = { slug };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  if (await pageRepo.count(where)) throw Conflict('A page with this URL already exists');
}

/** Exactly one home page: setting one clears the flag on the others. */
export async function clearOtherHomes(exceptId: number) {
  const { instituteId } = requireTenantContext();
  await WebsitePage.update({ isHome: false }, { where: { instituteId, id: { [Op.ne]: exceptId } } });
}

function status(p: WebsitePage): WebsitePageSummaryDto['status'] {
  if (!p.publishedVersionId) return 'draft';
  return p.hasDraftChanges ? 'changed' : 'published';
}

export function toPageSummary(p: WebsitePage): WebsitePageSummaryDto {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    isHome: p.isHome,
    showInNav: p.showInNav,
    sortOrder: p.sortOrder,
    status: status(p),
    publishedVersion: p.publishedVersion?.version ?? null,
    publishedAt: p.publishedVersion?.publishedAt?.toISOString() ?? null,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toPageDto(p: WebsitePage): WebsitePageDto {
  return { ...toPageSummary(p), blocks: p.blocks ?? [], seo: p.seo ?? {} };
}

export const withVersion = { include: [{ model: WebsitePageVersion, as: 'publishedVersion' }] };

export async function publishPage(page: WebsitePage) {
  const { userId, instituteId } = requireTenantContext();
  await assertMediaOwned(page.blocks, page.seo);
  const version = await getSequelize().transaction(async (transaction) => {
    const last = (await WebsitePageVersion.max('version', {
      where: { instituteId, pageId: page.id },
      transaction,
    })) as number | null;
    const v = await WebsitePageVersion.create(
      {
        instituteId,
        pageId: page.id,
        version: (last ?? 0) + 1,
        title: page.title,
        blocks: page.blocks,
        seo: page.seo,
        mediaFileIds: collectMediaFileIds(page.blocks, page.seo),
        publishedByUserId: userId ?? null,
        publishedAt: new Date(),
      },
      { transaction },
    );
    await page.update({ publishedVersionId: v.id, hasDraftChanges: false }, { transaction });
    return v;
  });
  invalidateSite(instituteId);
  return version;
}

export async function unpublishPage(page: WebsitePage) {
  await page.update({ publishedVersionId: null, hasDraftChanges: true });
  invalidateSite(page.instituteId);
}

export async function listVersions(page: WebsitePage): Promise<WebsitePageVersionDto[]> {
  const rows = await versionRepo.findAll({
    where: { pageId: page.id },
    include: [{ model: User, as: 'publishedBy', attributes: ['id', 'name'] }],
    order: [['version', 'DESC']],
    limit: 50,
  });
  return rows.map((v) => ({
    id: v.id,
    version: v.version,
    title: v.title,
    publishedAt: v.publishedAt.toISOString(),
    publishedByName: v.publishedBy?.name ?? null,
    isLive: v.id === page.publishedVersionId,
  }));
}

/** Copies a published version back into the draft (publish again to make it live). */
export async function restoreVersion(page: WebsitePage, versionId: number) {
  const v = await versionRepo.findOne({ where: { id: versionId, pageId: page.id } });
  if (!v) throw BadRequest('Unknown version for this page');
  await page.update({ title: v.title, blocks: v.blocks, seo: v.seo, hasDraftChanges: true });
  return v;
}

/** A starter home page for new sites. */
export function starterBlocks(instituteName: string): WebsiteBlock[] {
  return [
    {
      id: 'hero',
      type: 'hero',
      settings: {
        heading: `Welcome to ${instituteName}`,
        subheading: 'Expert coaching, proven results.',
        ctaLabel: 'Apply online',
        ctaHref: 'admission',
      },
    },
    {
      id: 'courses',
      type: 'courses',
      settings: { heading: 'Our courses', showDescription: true, showBuyButton: true },
    },
    { id: 'announcements', type: 'announcements', settings: { heading: 'Announcements', limit: 5 } },
    { id: 'enquiry-form', type: 'enquiry_form', settings: { heading: 'Have a question? Enquire now' } },
    { id: 'contact', type: 'contact', settings: { heading: 'Contact us' } },
  ];
}
