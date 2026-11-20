import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import type { ReferralEventDto, WebsiteAnnouncementDto } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission, requireTenant } from '../../shared/middleware/authorize';
import { getContext, requireTenantContext, runWithContext } from '../../shared/context';
import { BadRequest, Conflict } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { UserRole } from '../permissions/models';
import { User } from '../users/user.model';
import { invalidateSite } from './cache';
import {
  assertCodeFree,
  couponInputSchema,
  couponRepo,
  toCouponDto,
  validateCoupon,
} from './coupons.service';
import { CouponRedemption, ReferralEvent, WebsiteAnnouncement } from './models';
import {
  assertMediaOwned,
  assertSlugFree,
  clearOtherHomes,
  listVersions,
  pageInputSchema,
  pageRepo,
  publishPage,
  restoreVersion,
  starterBlocks,
  toPageDto,
  toPageSummary,
  unpublishPage,
  withVersion,
} from './pages.service';
import {
  assertReferralCodeFree,
  referralInputSchema,
  referralRepo,
  toReferralDto,
} from './referrals.service';
import {
  currentInstitute,
  getSite,
  siteBaseUrl,
  siteInputSchema,
  toSiteDto,
  updateSite,
  verifyCustomDomain,
} from './site.service';
import { collectMediaFileIds } from './blocks';
import { buildView, loadLiveSite, signedMediaResolver } from './view.service';

const M = 'website';
const can = (action: Parameters<typeof requirePermission>[1]) => requirePermission(M, action);

const announcementRepo = new TenantRepository(WebsiteAnnouncement, { entity: 'Announcement' });
const announcementSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(5000).nullable().optional(),
    linkUrl: z
      .string()
      .trim()
      .max(500)
      .regex(/^(https?:\/\/|\/(?!\/))/i, 'Use an http(s) URL or a site path')
      .nullable()
      .optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    isPinned: z.boolean().optional(),
    isPublished: z.boolean().optional(),
  })
  .refine((a) => !a.startsAt || !a.endsAt || a.startsAt <= a.endsAt, {
    message: 'End must be after start',
    path: ['endsAt'],
  });

function toAnnouncementDto(a: WebsiteAnnouncement): WebsiteAnnouncementDto {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    linkUrl: a.linkUrl,
    startsAt: a.startsAt?.toISOString() ?? null,
    endsAt: a.endsAt?.toISOString() ?? null,
    isPinned: a.isPinned,
    isPublished: a.isPublished,
  };
}

const listQuery = paginationSchema.extend({
  active: z.enum(['true', 'false']).optional(),
});

async function assertMember(userId: number | null | undefined) {
  if (!userId) return;
  const { instituteId } = requireTenantContext();
  if (!(await UserRole.count({ where: { instituteId, userId } }))) throw BadRequest('Unknown user');
}

const strip = <T extends object>(o: T) => JSON.parse(JSON.stringify(o)) as T;

export function websiteRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireTenant, requireModule(M));

  // ------------------------------------------------------------------ site settings / SEO
  r.get('/site', can('view'), async (_req, res) => {
    const [site, inst] = await Promise.all([getSite(), currentInstitute()]);
    res.json(toSiteDto(site, inst));
  });

  r.patch('/site', can('configure'), async (req, res) => {
    const body = parse(siteInputSchema, req.body);
    const { site, before } = await updateSite(body);
    await audit({
      action: 'website.site_updated',
      entityType: 'website_site',
      entityId: site.id,
      metadata: { before: strip(before), changes: body },
    });
    res.json(toSiteDto(site, await currentInstitute()));
  });

  r.post('/site/domain/verify', can('configure'), async (_req, res) => {
    const { site, verified, released } = await verifyCustomDomain();
    const domain = site.verifiedDomain;
    if (released) {
      // Tells the previous holder's admins why their domain stopped working, as a system event: the
      // actor, IP and institute of the other tenant stay out of their trail.
      await runWithContext({ requestId: getContext().requestId, system: true }, () =>
        audit({
          instituteId: released.instituteId,
          action: 'website.domain_released',
          entityType: 'website_site',
          entityId: released.id,
          metadata: { domain, reason: 'verified_elsewhere' },
        }),
      );
    }
    if (verified) {
      await audit({
        action: 'website.domain_verified',
        entityType: 'website_site',
        entityId: site.id,
        metadata: { domain, releasedFromInstituteId: released?.instituteId ?? null },
      });
    }
    res.json(toSiteDto(site, await currentInstitute()));
  });

  // ------------------------------------------------------------------ pages
  r.get('/pages', can('view'), async (_req, res) => {
    let pages = await pageRepo.findAll({
      ...withVersion,
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    if (!pages.length) {
      // New sites start with a draft home page so the builder is never empty.
      const inst = await currentInstitute();
      const home = await pageRepo.create({
        slug: 'home',
        title: 'Home',
        isHome: true,
        showInNav: true,
        sortOrder: 0,
        blocks: starterBlocks(inst.name),
        seo: null,
        hasDraftChanges: true,
      });
      await audit({
        action: 'website.page_created',
        entityType: 'website_page',
        entityId: home.id,
        metadata: { starter: true },
      });
      pages = await pageRepo.findAll({ ...withVersion });
    }
    res.json(pages.map(toPageSummary));
  });

  r.post('/pages', can('create'), async (req, res) => {
    const body = parse(pageInputSchema, req.body);
    await assertSlugFree(body.slug);
    const blocks = body.blocks ?? [];
    await assertMediaOwned(blocks, body.seo);
    const isFirst = (await pageRepo.count()) === 0;
    const page = await pageRepo.create({
      slug: body.slug,
      title: body.title,
      isHome: body.isHome ?? isFirst,
      showInNav: body.showInNav ?? true,
      sortOrder: body.sortOrder ?? 0,
      blocks,
      seo: body.seo ?? null,
      hasDraftChanges: true,
    });
    if (page.isHome) await clearOtherHomes(page.id);
    await audit({
      action: 'website.page_created',
      entityType: 'website_page',
      entityId: page.id,
      metadata: { slug: page.slug },
    });
    res.status(201).json(toPageDto(page));
  });

  r.get('/pages/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(toPageDto(await pageRepo.findById(id, withVersion)));
  });

  r.patch('/pages/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(pageInputSchema.partial(), req.body);
    const page = await pageRepo.findById(id, withVersion);
    if (body.slug && body.slug !== page.slug) await assertSlugFree(body.slug, id);
    if (body.blocks || body.seo !== undefined)
      await assertMediaOwned(body.blocks ?? page.blocks, body.seo ?? page.seo);
    if (body.isHome === false && page.isHome) throw BadRequest('Mark another page as the home page instead');
    const contentChanged = body.blocks !== undefined || body.seo !== undefined || body.title !== undefined;
    await page.update({ ...body, ...(contentChanged ? { hasDraftChanges: true } : {}) });
    if (body.isHome) await clearOtherHomes(page.id);
    // Slug, nav and ordering apply immediately to the live site.
    if (
      body.slug ||
      body.showInNav !== undefined ||
      body.sortOrder !== undefined ||
      body.isHome !== undefined
    )
      invalidateSite(page.instituteId);
    await audit({
      action: 'website.page_updated',
      entityType: 'website_page',
      entityId: page.id,
      metadata: { fields: Object.keys(body) },
    });
    res.json(toPageDto(page));
  });

  r.delete('/pages/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const page = await pageRepo.findById(id);
    if (page.isHome && (await pageRepo.count()) > 1)
      throw Conflict('Mark another page as the home page first');
    await page.destroy();
    invalidateSite(page.instituteId);
    await audit({
      action: 'website.page_deleted',
      entityType: 'website_page',
      entityId: id,
      metadata: { slug: page.slug },
    });
    res.status(204).end();
  });

  r.post('/pages/:id/publish', can('publish'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const page = await pageRepo.findById(id);
    const version = await publishPage(page);
    await audit({
      action: 'website.page_published',
      entityType: 'website_page',
      entityId: page.id,
      metadata: { version: version.version },
    });
    res.json(toPageDto(await pageRepo.findById(id, withVersion)));
  });

  r.post('/pages/:id/unpublish', can('publish'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const page = await pageRepo.findById(id);
    await unpublishPage(page);
    await audit({ action: 'website.page_unpublished', entityType: 'website_page', entityId: page.id });
    res.json(toPageDto(await pageRepo.findById(id, withVersion)));
  });

  r.get('/pages/:id/versions', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await listVersions(await pageRepo.findById(id)));
  });

  r.post('/pages/:id/versions/:versionId/restore', can('edit'), async (req, res) => {
    const { id, versionId } = parse(
      idParam.extend({ versionId: z.coerce.number().int().positive() }),
      req.params,
    );
    const page = await pageRepo.findById(id, withVersion);
    const v = await restoreVersion(page, versionId);
    await audit({
      action: 'website.page_version_restored',
      entityType: 'website_page',
      entityId: page.id,
      metadata: { version: v.version },
    });
    res.json(toPageDto(page));
  });

  /** Renders the current draft (with signed image URLs) for the builder's preview pane. */
  r.get('/pages/:id/preview', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const page = await pageRepo.findById(id);
    const live = await loadLiveSite();
    const mediaUrl = await signedMediaResolver(
      collectMediaFileIds(page.blocks ?? [], page.seo).concat(live.site.ogImageFileId ?? []),
    );
    const { html } = await buildView({
      live,
      page: {
        slug: page.slug,
        title: page.title,
        isHome: page.isHome,
        seo: page.seo,
        blocks: page.blocks ?? [],
      },
      basePath: live.site.baseUrl,
      ref: null,
      preview: true,
      mediaUrl,
    });
    res.json({ html });
  });

  // ------------------------------------------------------------------ announcements
  r.get('/announcements', can('view'), async (req, res) => {
    const q = parse(paginationSchema, req.query);
    const where: WhereOptions<WebsiteAnnouncement> = q.search
      ? { title: { [Op.like]: `%${q.search}%` } }
      : {};
    const { rows, count } = await announcementRepo.findAndCountAll({
      where,
      order: [
        ['isPinned', 'DESC'],
        ['id', 'DESC'],
      ],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(toAnnouncementDto), count, q));
  });

  r.post('/announcements', can('create'), async (req, res) => {
    const body = parse(announcementSchema, req.body);
    const a = await announcementRepo.create({
      title: body.title,
      body: body.body ?? null,
      linkUrl: body.linkUrl ?? null,
      startsAt: body.startsAt ?? null,
      endsAt: body.endsAt ?? null,
      isPinned: body.isPinned ?? false,
      isPublished: body.isPublished ?? true,
    });
    invalidateSite(a.instituteId);
    await audit({
      action: 'website.announcement_created',
      entityType: 'website_announcement',
      entityId: a.id,
    });
    res.status(201).json(toAnnouncementDto(a));
  });

  r.patch('/announcements/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const existing = await announcementRepo.findById(id);
    const body = parse(announcementSchema, { ...toAnnouncementDto(existing), ...req.body });
    const a = await announcementRepo.update(id, body);
    invalidateSite(a.instituteId);
    await audit({
      action: 'website.announcement_updated',
      entityType: 'website_announcement',
      entityId: a.id,
      metadata: { fields: Object.keys(req.body ?? {}) },
    });
    res.json(toAnnouncementDto(a));
  });

  r.delete('/announcements/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const a = await announcementRepo.findById(id);
    await a.destroy();
    invalidateSite(a.instituteId);
    await audit({ action: 'website.announcement_deleted', entityType: 'website_announcement', entityId: id });
    res.status(204).end();
  });

  // ------------------------------------------------------------------ coupons
  r.get('/coupons', can('view'), async (req, res) => {
    const q = parse(listQuery, req.query);
    const where: Record<string | symbol, unknown> = {};
    if (q.search) where.code = { [Op.like]: `%${q.search.toUpperCase()}%` };
    if (q.active) where.isActive = q.active === 'true';
    const { rows, count } = await couponRepo.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(toCouponDto), count, q));
  });

  r.post('/coupons', can('create'), async (req, res) => {
    const body = parse(couponInputSchema, req.body);
    await assertCodeFree(body.code);
    const c = await couponRepo.create({
      code: body.code,
      description: body.description ?? null,
      discountType: body.discountType,
      discountValue: body.discountValue,
      maxDiscount: body.maxDiscount ?? null,
      minAmount: body.minAmount ?? null,
      validFrom: body.validFrom ?? null,
      validUntil: body.validUntil ?? null,
      usageLimit: body.usageLimit ?? null,
      perCustomerLimit: body.perCustomerLimit ?? null,
      courseIds: body.courseIds?.length ? body.courseIds : null,
      isActive: body.isActive ?? true,
    });
    await audit({
      action: 'website.coupon_created',
      entityType: 'coupon',
      entityId: c.id,
      metadata: { code: c.code },
    });
    res.status(201).json(toCouponDto(c));
  });

  r.get('/coupons/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(toCouponDto(await couponRepo.findById(id)));
  });

  r.patch('/coupons/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const existing = await couponRepo.findById(id);
    const body = parse(couponInputSchema, { ...toCouponDto(existing), ...req.body });
    if (body.code !== existing.code) {
      if (existing.usedCount > 0) throw Conflict('A coupon that has been used cannot be renamed');
      await assertCodeFree(body.code, id);
    }
    const c = await couponRepo.update(id, {
      ...body,
      courseIds: body.courseIds?.length ? body.courseIds : null,
    });
    await audit({
      action: 'website.coupon_updated',
      entityType: 'coupon',
      entityId: c.id,
      metadata: { before: toCouponDto(existing), changes: req.body },
    });
    res.json(toCouponDto(c));
  });

  r.delete('/coupons/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const c = await couponRepo.findById(id);
    if (c.usedCount > 0) throw Conflict('This coupon has been used; deactivate it instead', 'COUPON_IN_USE');
    await CouponRedemption.destroy({ where: { instituteId: c.instituteId, couponId: c.id } });
    await c.destroy();
    await audit({
      action: 'website.coupon_deleted',
      entityType: 'coupon',
      entityId: id,
      metadata: { code: c.code },
    });
    res.status(204).end();
  });

  r.post('/coupons/validate', can('view'), async (req, res) => {
    const body = parse(
      z.object({
        code: z.string().trim().min(1).max(40),
        amountPaise: z.number().int().min(0).max(1e11),
        courseId: z.number().int().positive().nullable().optional(),
        customerKey: z.string().trim().max(100).nullable().optional(),
      }),
      req.body,
    );
    res.json(await validateCoupon(body));
  });

  r.get('/coupons/:id/redemptions', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const q = parse(paginationSchema, req.query);
    const c = await couponRepo.findById(id);
    const { rows, count } = await CouponRedemption.findAndCountAll({
      where: { instituteId: c.instituteId, couponId: c.id },
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(
      paginated(
        rows.map((x) => ({
          id: x.id,
          orderRef: x.orderRef,
          customerKey: x.customerKey,
          amountPaise: Number(x.amountPaise),
          discountPaise: Number(x.discountPaise),
          status: x.status,
          createdAt: x.createdAt.toISOString(),
        })),
        count,
        q,
      ),
    );
  });

  // ------------------------------------------------------------------ referrals
  const referrerInclude = { include: [{ model: User, as: 'referrer', attributes: ['id', 'name'] }] };
  const siteBase = async () => siteBaseUrl(await getSite(), await currentInstitute());

  r.get('/referrals', can('view'), async (req, res) => {
    const q = parse(listQuery, req.query);
    const where: Record<string | symbol, unknown> = {};
    if (q.search)
      where[Op.or] = [
        { code: { [Op.like]: `%${q.search.toUpperCase()}%` } },
        { name: { [Op.like]: `%${q.search}%` } },
      ];
    if (q.active) where.isActive = q.active === 'true';
    const { rows, count } = await referralRepo.findAndCountAll({
      where,
      ...referrerInclude,
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    const base = await siteBase();
    res.json(
      paginated(
        rows.map((x) => toReferralDto(x, base)),
        count,
        q,
      ),
    );
  });

  r.post('/referrals', can('create'), async (req, res) => {
    const body = parse(referralInputSchema, req.body);
    await assertReferralCodeFree(body.code);
    await assertMember(body.referrerUserId);
    const rc = await referralRepo.create({
      code: body.code,
      name: body.name,
      referrerUserId: body.referrerUserId ?? null,
      commissionNote: body.commissionNote ?? null,
      isActive: body.isActive ?? true,
    });
    await audit({
      action: 'website.referral_created',
      entityType: 'referral_code',
      entityId: rc.id,
      metadata: { code: rc.code },
    });
    res
      .status(201)
      .json(toReferralDto(await referralRepo.findById(rc.id, referrerInclude), await siteBase()));
  });

  r.patch('/referrals/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(referralInputSchema.partial(), req.body);
    const existing = await referralRepo.findById(id);
    if (body.code && body.code !== existing.code) {
      if (existing.clicks + existing.signups + existing.purchases > 0)
        throw Conflict('A referral code with activity cannot be renamed');
      await assertReferralCodeFree(body.code, id);
    }
    await assertMember(body.referrerUserId);
    await referralRepo.update(id, body);
    await audit({
      action: 'website.referral_updated',
      entityType: 'referral_code',
      entityId: id,
      metadata: { changes: body },
    });
    res.json(toReferralDto(await referralRepo.findById(id, referrerInclude), await siteBase()));
  });

  r.delete('/referrals/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const rc = await referralRepo.findById(id);
    await ReferralEvent.destroy({ where: { instituteId: rc.instituteId, referralCodeId: rc.id } });
    await rc.destroy();
    await audit({
      action: 'website.referral_deleted',
      entityType: 'referral_code',
      entityId: id,
      metadata: { code: rc.code },
    });
    res.status(204).end();
  });

  r.get('/referrals/:id/events', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const q = parse(
      paginationSchema.extend({ kind: z.enum(['click', 'signup', 'purchase']).optional() }),
      req.query,
    );
    const rc = await referralRepo.findById(id);
    const { rows, count } = await ReferralEvent.findAndCountAll({
      where: { instituteId: rc.instituteId, referralCodeId: rc.id, ...(q.kind ? { kind: q.kind } : {}) },
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(
      paginated(
        rows.map<ReferralEventDto>((e) => ({
          id: e.id,
          kind: e.kind,
          refType: e.refType,
          refId: e.refId,
          amountPaise: e.amountPaise === null ? null : Number(e.amountPaise),
          createdAt: e.createdAt.toISOString(),
        })),
        count,
        q,
      ),
    );
  });

  api.use('/website', r);
}
