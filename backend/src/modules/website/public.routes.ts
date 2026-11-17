/**
 * Public website, mounted at `/api/public/sites/:site` (`:site` = institute slug, or `_host` to
 * resolve from the Host header: custom domain or `<subdomain>.<platform domain>`). No auth; the
 * institute comes only from the URL/host, never from the client body.
 */
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PublicCheckoutResult } from '@erp/shared';
import { getStorage } from '../../infrastructure/storage';
import { authRateLimit } from '../../shared/middleware/security';
import { parse } from '../../shared/utilities/validation';
import { AppError, BadRequest, NotFound } from '../../shared/errors';
import { FileObject } from '../files/file.model';
import { Batch } from '../academics/api';
import { PUBLIC_CACHE_CONTROL, cached } from './cache';
import { findPublicCourse } from './content.service';
import { validateCoupon } from './coupons.service';
import { resolveCheckout } from './hooks';
import { publicLeadSchema, submitLead } from './leads.service';
import { recordReferralClick, visitorHash } from './referrals.service';
import { renderSitemap } from './render';
import { asInstitute, resolvePublicSite, type PublicSite } from './site.service';
import {
  buildView,
  findLivePage,
  homePage,
  loadLiveSite,
  publicMediaIds,
  type LiveSite,
} from './view.service';

const HTML_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src * data:',
  'frame-src https://www.google.com https://maps.google.com',
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const REF = /^[A-Z0-9_-]{3,40}$/;
const cleanRef = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return REF.test(s) ? s : null;
};

const FORM_ERRORS: Record<string, string> = {
  VALIDATION_ERROR: 'Please check your details and try again.',
  ENQUIRIES_DISABLED: 'Online enquiries are not available right now. Please call us instead.',
  RATE_LIMITED: 'Too many attempts. Please try again in a few minutes.',
};

async function site(req: Request): Promise<PublicSite> {
  return resolvePublicSite(String(req.params.site), req.hostname);
}

function sendHtml(res: Response, html: string, cache: boolean) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', HTML_CSP);
  res.setHeader('Cache-Control', cache ? PUBLIC_CACHE_CONTROL : 'no-store');
  res.send(html);
}

async function renderLive(req: Request, res: Response, slug: string | null) {
  const s = await site(req);
  const ref = cleanRef(req.query.ref);
  const submitted = typeof req.query.submitted === 'string' ? req.query.submitted : null;
  const formError = typeof req.query.formError === 'string' ? req.query.formError : null;
  const html = await asInstitute(s.instituteId, async () => {
    const live = await loadLiveSite();
    const page = slug ? findLivePage(live, slug) : homePage(live);
    if (!page) throw NotFound('Page');
    let flash = null;
    if (submitted || formError) {
      const block = page.blocks.find((b) => b.id === (submitted ?? formError));
      if (block && (block.type === 'enquiry_form' || block.type === 'demo_form')) {
        flash = submitted
          ? {
              blockId: block.id,
              ok: true,
              message: block.settings.successMessage ?? 'Thank you! We will contact you shortly.',
            }
          : {
              blockId: block.id,
              ok: false,
              message: FORM_ERRORS[String(req.query.code)] ?? 'Something went wrong. Please try again.',
            };
      }
    }
    const render = () =>
      buildView({ live, page, basePath: s.basePath, ref, preview: false, flash }).then((v) => v.html);
    // Flash messages are per-visitor; everything else is cacheable (ref only changes link query strings).
    return flash ? render() : cached(s.instituteId, `html:${s.basePath}:${page.slug}:${ref ?? ''}`, render);
  });
  sendHtml(res, html, !submitted && !formError);
}

function wantsJson(req: Request) {
  return req.is('application/json') === 'application/json' || req.query.format === 'json';
}

export function websitePublicRoutes(api: Router) {
  const pub = Router();
  pub.use(express.urlencoded({ extended: true, limit: '64kb' }));

  pub.get('/:site/resolve', async (req, res) => {
    const s = await site(req);
    res.json(s);
  });

  pub.get('/:site/site', async (req, res) => {
    const s = await site(req);
    const live = await asInstitute(s.instituteId, loadLiveSite);
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    res.json({
      institute: live.institute,
      theme: live.site.theme,
      seo: { ...live.site.seo, indexable: live.site.indexable },
      baseUrl: live.site.baseUrl,
      admissionUrl: live.site.admissionUrl,
      pages: live.pages.map((p) => ({
        slug: p.slug,
        title: p.title,
        isHome: p.isHome,
        showInNav: p.showInNav,
      })),
    });
  });

  pub.get('/:site/pages/:page', async (req, res) => {
    const s = await site(req);
    const data = await asInstitute(s.instituteId, async () => {
      const live = await loadLiveSite();
      const page = findLivePage(live, String(req.params.page));
      if (!page) throw NotFound('Page');
      return cached(s.instituteId, `json:${page.slug}`, async () => {
        const { blocks } = await buildView({ live, page, basePath: s.basePath, ref: null, preview: false });
        return { slug: page.slug, title: page.title, isHome: page.isHome, seo: page.seo ?? {}, blocks };
      });
    });
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    res.json(data);
  });

  pub.get('/:site/sitemap.xml', async (req, res) => {
    const s = await site(req);
    const live = await asInstitute(s.instituteId, loadLiveSite);
    const urls = live.site.indexable
      ? live.pages.map((p) => ({
          loc: p.isHome ? `${live.site.baseUrl}/` : `${live.site.baseUrl}/p/${encodeURIComponent(p.slug)}`,
          lastmod: p.publishedAt,
        }))
      : [];
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    res.send(renderSitemap(urls));
  });

  pub.get('/:site/robots.txt', async (req, res) => {
    const s = await site(req);
    const live: LiveSite = await asInstitute(s.instituteId, loadLiveSite);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    res.send(
      live.site.indexable
        ? `User-agent: *\nAllow: /\nDisallow: /forms/\nDisallow: /checkout/\nSitemap: ${live.site.baseUrl}/sitemap.xml\n`
        : 'User-agent: *\nDisallow: /\n',
    );
  });

  pub.get('/:site/media/:fileId', async (req, res) => {
    const s = await site(req);
    const fileId = Number(req.params.fileId);
    const file = await asInstitute(s.instituteId, async () => {
      const live = await loadLiveSite();
      if (!Number.isInteger(fileId) || !publicMediaIds(live).has(fileId)) throw NotFound('Image');
      return FileObject.findOne({ where: { id: fileId, instituteId: s.instituteId } });
    });
    if (!file || !file.mimeType.startsWith('image/')) throw NotFound('Image');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    (await getStorage().getStream(file.storageKey)).pipe(res);
  });

  // Referral link: count the click, then land on the home page carrying the code.
  pub.get('/:site/r/:code', async (req, res) => {
    const s = await site(req);
    const code = cleanRef(req.params.code);
    if (code)
      await asInstitute(s.instituteId, () =>
        recordReferralClick(code, visitorHash(req.ip, req.get('user-agent'))),
      );
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, `${s.basePath}/${code ? `?ref=${encodeURIComponent(code)}` : ''}`);
  });

  pub.post('/:site/referrals/:code/click', authRateLimit, async (req, res) => {
    const s = await site(req);
    const code = cleanRef(req.params.code);
    const counted = code
      ? await asInstitute(s.instituteId, () =>
          recordReferralClick(code, visitorHash(req.ip, req.get('user-agent'))),
        )
      : false;
    res.json({ counted });
  });

  pub.post('/:site/coupons/validate', authRateLimit, async (req, res) => {
    const s = await site(req);
    const body = parse(
      z.object({
        code: z.string().trim().min(1).max(40),
        amountPaise: z.number().int().min(0).max(1e11),
        courseId: z.number().int().positive().nullable().optional(),
      }),
      req.body,
    );
    const result = await asInstitute(s.instituteId, () => validateCoupon(body));
    res.json({ ...result, couponId: null });
  });

  const checkoutQuery = z.object({
    coupon: z.string().trim().max(40).optional(),
    ref: z.string().optional(),
    batchId: z.coerce.number().int().positive().optional(),
  });
  const checkout = async (req: Request, res: Response) => {
    const s = await site(req);
    const q = parse(checkoutQuery, { ...req.query, ...(req.method === 'POST' ? req.body : {}) });
    const courseId = Number(req.params.courseId);
    if (!Number.isInteger(courseId) || courseId <= 0) throw BadRequest('Invalid course');
    const ref = cleanRef(q.ref);
    const result = await asInstitute(s.instituteId, async (): Promise<PublicCheckoutResult> => {
      const live = await loadLiveSite();
      const course = await findPublicCourse(courseId);
      if (!course) throw NotFound('Course');
      if (q.batchId) {
        const batch = await Batch.findOne({ where: { instituteId: s.instituteId, id: q.batchId, courseId } });
        if (!batch || !['planned', 'active'].includes(batch.status))
          throw BadRequest('This batch is not open');
      }
      const handoff = await resolveCheckout({
        instituteId: s.instituteId,
        instituteSlug: s.slug,
        courseId,
        batchId: q.batchId ?? null,
        couponCode: q.coupon ? q.coupon.toUpperCase() : null,
        referralCode: ref,
        returnUrl: `${live.site.baseUrl}/`,
      });
      if (handoff?.url && /^https?:\/\//i.test(handoff.url)) return { url: handoff.url, handler: 'fees' };
      const url = new URL(live.site.admissionUrl);
      if (ref) url.searchParams.set('ref', ref);
      url.searchParams.set('courseId', String(courseId));
      return { url: url.toString(), handler: 'admission' };
    });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' || req.query.format === 'json') res.json(result);
    else res.redirect(302, result.url);
  };
  pub.get('/:site/checkout/:courseId', checkout);
  pub.post('/:site/checkout/:courseId', authRateLimit, checkout);

  // Enquiry / demo-class forms → admissions enquiries. JSON for API clients; HTML forms get a
  // 303 redirect back to the page with a flash (post/redirect/get).
  pub.post('/:site/forms/:page', authRateLimit, async (req, res) => {
    const s = await site(req);
    const json = wantsJson(req);
    const pageSlug = String(req.params.page).toLowerCase();
    const blockId = typeof req.body?.block === 'string' ? req.body.block : '';
    const homeSlug = await asInstitute(s.instituteId, async () => homePage(await loadLiveSite())?.slug);
    const back = (params: Record<string, string>) => {
      const q = new URLSearchParams(params);
      const ref = cleanRef(req.body?.ref);
      if (ref) q.set('ref', ref);
      const path = pageSlug === homeSlug ? '/' : `/p/${encodeURIComponent(pageSlug)}`;
      return `${s.basePath}${path}?${q}#${encodeURIComponent(blockId)}`;
    };
    try {
      const result = await asInstitute(s.instituteId, async () => {
        const live = await loadLiveSite();
        const page = findLivePage(live, pageSlug);
        const block = page?.blocks.find((b) => b.id === blockId && !b.hidden);
        if (!page || !block || (block.type !== 'enquiry_form' && block.type !== 'demo_form'))
          throw NotFound('Form');
        const input = parse(publicLeadSchema, { ...req.body, ref: cleanRef(req.body?.ref) });
        return submitLead(block, input, page.slug);
      });
      if (json) res.status(201).json(result);
      else res.redirect(303, back({ submitted: blockId }));
    } catch (err) {
      if (json || !(err instanceof AppError) || err.status === 404) throw err;
      res.redirect(303, back({ formError: blockId, code: err.code }));
    }
  });

  pub.get('/:site/p/:page', (req, res) => renderLive(req, res, String(req.params.page)));
  pub.get('/:site', (req, res) => renderLive(req, res, null));

  api.use('/public/sites', pub);
}
