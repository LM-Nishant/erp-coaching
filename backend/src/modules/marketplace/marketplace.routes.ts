import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  CHECKOUT_PLATFORMS,
  MKT_COUPON_KINDS,
  MKT_COURSE_LEVELS,
  MKT_COURSE_STATUSES,
  MKT_LECTURE_TYPES,
  MKT_MAX_PRICE_PAISE,
  MKT_MEDIA_KINDS,
  MKT_SORTS,
  MKT_UPLOAD_CHUNK_BYTES,
  type PermissionAction,
} from '@erp/shared';
import { logger } from '../../infrastructure/logger';
import { getStorage } from '../../infrastructure/storage';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { withContext } from '../../shared/middleware/context';
import {
  authRateLimit,
  mediaRateLimit,
  mediaTokenRateLimit,
  webhookRateLimit,
} from '../../shared/middleware/security';
import { BadRequest, NotFound } from '../../shared/errors';
import { idParam } from '../../shared/utilities/pagination';
import { parse } from '../../shared/utilities/validation';
import { sendCheckoutReturn, verifyCheckoutReturn } from '../../shared/utilities/checkout-return';
import { setFileResponseHeaders } from '../../shared/utilities/file-response';
import * as account from './account.service';
import * as admin from './admin.service';
import * as catalog from './catalog.service';
import * as commerce from './commerce.service';
import * as coupons from './coupons.service';
import * as courses from './courses.service';
import { engagementRoutes } from './engagement.routes';
import * as learning from './learning.service';
import * as media from './media.service';
import { certificatePublicRoutes, quizAdminRoutes, quizLearnerRoutes, quizStudioRoutes } from './quiz.routes';
import { payoutRoutes } from './payouts.routes';
import * as sellers from './sellers.service';
import { MARKETPLACE } from './util';

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const optId = z.number().int().positive().nullable().optional();
const list = z.array(z.string().trim().max(200)).max(20);
const ids = (...names: string[]) =>
  z.object(Object.fromEntries(names.map((n) => [n, z.coerce.number().int().positive()])));

const courseInput = z.object({
  title: text(160),
  subtitle: optText(200),
  description: optText(20000),
  categoryId: optId,
  subcategoryId: optId,
  level: z.enum(MKT_COURSE_LEVELS).optional(),
  language: z.string().trim().min(2).max(10).optional(),
  pricePaise: z.number().int().min(0).max(MKT_MAX_PRICE_PAISE).optional(),
  outcomes: list.optional(),
  requirements: list.optional(),
  audience: list.optional(),
  thumbnailMediaId: optId,
  promoMediaId: optId,
});
const sectionInput = z.object({ title: text(200) });
const lectureInput = z.object({
  title: text(200),
  type: z.enum(MKT_LECTURE_TYPES),
  description: optText(5000),
  articleBody: z.string().max(200_000).nullable().optional(),
  mediaId: optId,
  preview: z.boolean().optional(),
  durationSeconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600)
    .nullable()
    .optional(),
});
const profileInput = z.object({
  displayName: text(150),
  headline: optText(200),
  bio: optText(5000),
  website: z
    .string()
    .trim()
    .url()
    .max(255)
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  avatarMediaId: optId,
});
const couponInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{3,40}$/, 'Use 3-40 letters, digits, - or _'),
  kind: z.enum(MKT_COUPON_KINDS),
  value: z.number().int().positive().max(MKT_MAX_PRICE_PAISE),
  courseIds: z.array(z.number().int().positive()).max(200).optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  active: z.boolean().optional(),
});
const catalogQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(120).optional(),
  level: z.enum(MKT_COURSE_LEVELS).optional(),
  language: z.string().trim().max(10).optional(),
  price: z.enum(['free', 'paid']).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  seller: z.string().trim().max(120).optional(),
  sort: z.enum(MKT_SORTS).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(48).optional(),
});
const slugParam = z.object({ slug: z.string().trim().min(1).max(120) });
const chunkBody = withContext(
  express.raw({ type: () => true, limit: MKT_UPLOAD_CHUNK_BYTES + 1024 }) as express.RequestHandler,
);

/** Streams a stored object, honouring a single Range header (video seeking, resumable downloads). */
async function sendStored(
  req: Request,
  res: Response,
  key: string,
  size: number,
  meta: { mimeType: string; originalName: string },
  cache: string,
) {
  setFileResponseHeaders(res, meta, cache);
  res.setHeader('Accept-Ranges', 'bytes');
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.header('range') ?? '');
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    (await getStorage().getStream(key, { start, end })).pipe(res);
    return;
  }
  res.setHeader('Content-Length', String(size));
  (await getStorage().getStream(key)).pipe(res);
}

// ------------------------------------------------------------------ public

function publicRoutes(api: Router) {
  api.get('/marketplace/public/home', async (_req, res) => {
    res.json(await catalog.home());
  });
  api.get('/marketplace/public/categories', async (_req, res) => {
    res.json(await catalog.listCategories());
  });
  api.get('/marketplace/public/courses', async (req, res) => {
    res.json(await catalog.searchCourses(parse(catalogQuery, req.query)));
  });
  api.get('/marketplace/public/courses/:slug', async (req, res) => {
    res.json(await catalog.courseDetail(parse(slugParam, req.params).slug));
  });
  api.get('/marketplace/public/instructors/:slug', async (req, res) => {
    res.json(await catalog.sellerPage(parse(slugParam, req.params).slug));
  });
  api.get('/marketplace/public/lectures/:id/preview', async (req, res) => {
    res.json(await catalog.previewLecture(parse(idParam, req.params).id));
  });

  // Media links: the signed token is the credential (players fetch segments without headers).
  api.get('/marketplace/public/hls/:token/:name', mediaRateLimit, mediaTokenRateLimit, async (req, res) => {
    const name = String(req.params.name);
    const m = await media.mediaForToken(String(req.params.token));
    if (!m?.hlsPrefix || !media.HLS_NAME.test(name)) throw NotFound('Stream');
    const key = `${m.hlsPrefix}/${name}`;
    const stat = await getStorage().stat(key);
    if (!stat) throw NotFound('Stream');
    res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    (await getStorage().getStream(key)).pipe(res);
  });
  api.get('/marketplace/public/media/:token', mediaRateLimit, mediaTokenRateLimit, async (req, res) => {
    const m = await media.mediaForToken(String(req.params.token));
    if (!m) throw NotFound('File');
    await sendStored(
      req,
      res,
      m.storageKey,
      m.sizeBytes,
      m,
      m.kind === 'image' ? 'public, max-age=86400' : 'private, max-age=60',
    );
  });

  // Learner sign-up: anonymous write, so it shares the sign-in rate limit.
  api.post('/marketplace/public/signup', authRateLimit, async (req, res) => {
    const body = parse(
      z.object({
        name: text(150),
        mobile: z
          .string()
          .trim()
          .regex(/^\+?\d{10,15}$/, 'Enter a valid mobile number'),
        email: z
          .string()
          .trim()
          .email()
          .max(150)
          .nullable()
          .optional()
          .or(z.literal('').transform(() => null)),
        password: z.string().min(8).max(200),
      }),
      req.body,
    );
    res.status(201).json(await account.signup(body));
  });

  // Gateway webhooks: the signature is verified with the platform's credentials.
  api.post(
    '/marketplace/public/webhooks/:gateway',
    webhookRateLimit,
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const { gateway } = parse(z.object({ gateway: z.string().regex(/^[a-z0-9-]{2,30}$/) }), req.params);
      const raw =
        req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
      res.json({ received: true, ...(await commerce.processWebhook(gateway, raw, req.headers)) });
    },
  );

  // The payer's browser coming back from a redirect checkout.
  const checkoutReturn = async (req: Request, res: Response) => {
    const target = verifyCheckoutReturn('marketplace', String(req.params.token ?? ''));
    if (target)
      await commerce
        .syncReturnedOrder(target.paymentId)
        .catch((err: Error) =>
          logger.warn(
            { orderId: target.paymentId, reason: err.message },
            'Checkout return status check failed',
          ),
        );
    sendCheckoutReturn(res, target);
  };
  api.get('/marketplace/public/checkout-return/:token', webhookRateLimit, checkoutReturn);
  api.post(
    '/marketplace/public/checkout-return/:token',
    webhookRateLimit,
    express.urlencoded({ extended: false, limit: '64kb' }),
    checkoutReturn,
  );
}

// ------------------------------------------------------------------ learner (any signed-in user)

function learnerRoutes(api: Router) {
  const r = Router();
  r.use(authenticate);

  r.get('/account', async (_req, res) => {
    res.json(await account.account());
  });
  r.put('/instructor-profile', async (req, res) => {
    res.json(await sellers.saveInstructorProfile(parse(profileInput, req.body)));
  });

  r.get('/courses/:id/access', async (req, res) => {
    res.json(await commerce.courseAccess(parse(idParam, req.params).id));
  });
  r.post('/courses/:id/enrol', async (req, res) => {
    res.status(201).json(await commerce.enrolFree(parse(idParam, req.params).id));
  });

  r.get('/cart', async (req, res) => {
    const { coupon } = parse(z.object({ coupon: z.string().trim().max(40).optional() }), req.query);
    res.json(await commerce.getCart(coupon));
  });
  r.post('/cart/items', async (req, res) => {
    const { courseId } = parse(z.object({ courseId: z.number().int().positive() }), req.body);
    res.status(201).json(await commerce.addToCart(courseId));
  });
  r.delete('/cart/items/:id', async (req, res) => {
    res.json(await commerce.removeFromCart(parse(idParam, req.params).id));
  });

  r.post('/checkout', async (req, res) => {
    const body = parse(
      z.object({
        courseIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
        couponCode: z.string().trim().max(40).nullable().optional(),
        idempotencyKey: z.string().trim().min(8).max(100).optional(),
        returnTo: z
          .object({ platform: z.enum(CHECKOUT_PLATFORMS), path: z.string().max(80).optional() })
          .nullable()
          .optional(),
      }),
      req.body ?? {},
    );
    res.status(201).json(
      await commerce.startCheckout({
        ...body,
        idempotencyKey: req.header('idempotency-key') ?? body.idempotencyKey ?? null,
      }),
    );
  });
  r.get('/orders', async (_req, res) => {
    res.json(await commerce.listOrders());
  });
  r.get('/orders/:id', async (req, res) => {
    res.json(await commerce.getOrder(parse(idParam, req.params).id));
  });
  r.post('/orders/:id/sync', async (req, res) => {
    res.json(await commerce.syncPayment(parse(idParam, req.params).id));
  });
  // Development/test: completes a mock gateway checkout (404 in production).
  r.post('/orders/:id/mock-complete', async (req, res) => {
    const { outcome } = parse(
      z.object({ outcome: z.enum(['success', 'failed']).default('success') }),
      req.body ?? {},
    );
    res.json(await commerce.completeMockCheckout(parse(idParam, req.params).id, outcome));
  });

  r.get('/learning', async (_req, res) => {
    res.json(await learning.myLearning());
  });
  r.get('/learning/:id', async (req, res) => {
    res.json(await learning.player(parse(idParam, req.params).id));
  });
  r.get('/learning/:id/lectures/:lectureId', async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    res.json(await learning.lecture(p.id, p.lectureId));
  });
  r.put('/learning/:id/lectures/:lectureId/progress', async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    const body = parse(
      z.object({
        positionSeconds: z
          .number()
          .min(0)
          .max(24 * 3600)
          .optional(),
        completed: z.boolean().optional(),
      }),
      req.body ?? {},
    );
    res.json(await learning.saveProgress(p.id, p.lectureId, body));
  });
  quizLearnerRoutes(r);

  api.use('/marketplace', r);
}

// ------------------------------------------------------------------ studio (instructor / institute)

type Guard = (action: PermissionAction) => RequestHandler[];

/**
 * Course builder routes, mounted twice: `/marketplace/instructor` (the user's own instructor
 * profile, no institute permission needed) and `/marketplace/institute` (the institute's
 * storefront, guarded by `marketplace.*` permissions).
 */
function studioRoutes(scope: sellers.SellerScope, can: Guard): Router {
  const r = Router();
  const seller = async () => (await sellers.currentSeller(scope)).id;

  r.get('/profile', ...can('view'), async (_req, res) => {
    res.json(await sellers.toSellerAdminDto(await sellers.currentSeller(scope)));
  });
  if (scope === 'institute')
    r.put('/profile', ...can('configure'), async (req, res) => {
      res.json(await sellers.saveInstituteProfile(parse(profileInput, req.body)));
    });

  // media uploads (resumable: create, then PUT chunks at ?offset=)
  r.post('/media', ...can('edit'), async (req, res) => {
    const body = parse(
      z.object({
        kind: z.enum(MKT_MEDIA_KINDS),
        name: text(255),
        mimeType: z.string().trim().min(3).max(120),
        sizeBytes: z.number().int().positive(),
        durationSeconds: z
          .number()
          .int()
          .min(0)
          .max(24 * 3600)
          .nullable()
          .optional(),
      }),
      req.body,
    );
    res.status(201).json(await media.startMediaUpload(await seller(), body));
  });
  r.get('/media/:id', ...can('view'), async (req, res) => {
    res.json(media.toMediaDto(await media.sellerMedia(await seller(), parse(idParam, req.params).id)));
  });
  r.put('/media/:id/content', ...can('edit'), chunkBody, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { offset } = parse(z.object({ offset: z.coerce.number().int().min(0) }), req.query);
    if (!Buffer.isBuffer(req.body)) throw BadRequest('Send the chunk as application/octet-stream');
    res.json(await media.appendMediaChunk(await seller(), id, offset, req.body));
  });

  r.get('/courses', ...can('view'), async (_req, res) => {
    res.json(await courses.listOwnCourses(await seller()));
  });
  r.post('/courses', ...can('create'), async (req, res) => {
    res.status(201).json(await courses.createCourse(await seller(), parse(courseInput, req.body)));
  });
  r.get('/courses/:id', ...can('view'), async (req, res) => {
    res.json(await courses.getOwnCourse(await seller(), parse(idParam, req.params).id));
  });
  r.patch('/courses/:id', ...can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await courses.updateCourse(await seller(), id, parse(courseInput.partial(), req.body)));
  });
  r.delete('/courses/:id', ...can('delete'), async (req, res) => {
    await courses.deleteCourse(await seller(), parse(idParam, req.params).id);
    res.status(204).end();
  });
  r.get('/courses/:id/readiness', ...can('view'), async (req, res) => {
    res.json(await courses.courseReadiness(await seller(), parse(idParam, req.params).id));
  });
  r.post('/courses/:id/submit', ...can('publish'), async (req, res) => {
    res.json(await courses.submitForReview(await seller(), parse(idParam, req.params).id));
  });
  r.post('/courses/:id/unpublish', ...can('publish'), async (req, res) => {
    res.json(await courses.sellerUnpublish(await seller(), parse(idParam, req.params).id));
  });
  r.put('/courses/:id/curriculum-order', ...can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { sections } = parse(
      z.object({
        sections: z
          .array(
            z.object({
              id: z.number().int().positive(),
              lectureIds: z.array(z.number().int().positive()).max(500),
            }),
          )
          .max(200),
      }),
      req.body,
    );
    res.json(await courses.reorderCurriculum(await seller(), id, sections));
  });
  r.post('/courses/:id/sections', ...can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.status(201).json(await courses.addSection(await seller(), id, parse(sectionInput, req.body)));
  });
  r.patch('/courses/:id/sections/:sectionId', ...can('edit'), async (req, res) => {
    const p = parse(ids('id', 'sectionId'), req.params);
    res.json(await courses.updateSection(await seller(), p.id, p.sectionId, parse(sectionInput, req.body)));
  });
  r.delete('/courses/:id/sections/:sectionId', ...can('edit'), async (req, res) => {
    const p = parse(ids('id', 'sectionId'), req.params);
    res.json(await courses.deleteSection(await seller(), p.id, p.sectionId));
  });
  r.post('/courses/:id/sections/:sectionId/lectures', ...can('edit'), async (req, res) => {
    const p = parse(ids('id', 'sectionId'), req.params);
    res
      .status(201)
      .json(await courses.addLecture(await seller(), p.id, p.sectionId, parse(lectureInput, req.body)));
  });
  r.patch('/courses/:id/lectures/:lectureId', ...can('edit'), async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    res.json(
      await courses.updateLecture(await seller(), p.id, p.lectureId, parse(lectureInput.partial(), req.body)),
    );
  });
  r.delete('/courses/:id/lectures/:lectureId', ...can('edit'), async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    res.json(await courses.deleteLecture(await seller(), p.id, p.lectureId));
  });
  r.get('/courses/:id/lectures/:lectureId/content', ...can('view'), async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    await courses.ownCourse(await seller(), p.id);
    res.json(await admin.reviewLecture(p.id, p.lectureId));
  });

  r.get('/coupons', ...can('view'), async (_req, res) => {
    res.json(await coupons.listCoupons(await seller()));
  });
  r.post('/coupons', ...can('configure'), async (req, res) => {
    res.status(201).json(await coupons.createCoupon(await seller(), parse(couponInput, req.body)));
  });
  r.patch('/coupons/:id', ...can('configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await coupons.updateCoupon(await seller(), id, parse(couponInput.partial(), req.body)));
  });
  r.delete('/coupons/:id', ...can('configure'), async (req, res) => {
    await coupons.deleteCoupon(await seller(), parse(idParam, req.params).id);
    res.status(204).end();
  });

  r.get('/sales', ...can('view'), async (req, res) => {
    const q = parse(
      z.object({
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    );
    res.json(await admin.ledger({ ...q, sellerId: await seller() }));
  });
  quizStudioRoutes(r, scope, can, seller);
  return r;
}

// ------------------------------------------------------------------ platform admin

function adminRoutes(api: Router) {
  const a = Router();
  a.use(authenticate, requireSuperAdmin);

  a.get('/courses', async (req, res) => {
    const { status } = parse(
      z.object({ status: z.enum(MKT_COURSE_STATUSES).default('in_review') }),
      req.query,
    );
    res.json(await admin.reviewQueue(status));
  });
  a.get('/courses/:id', async (req, res) => {
    res.json(await admin.reviewCourse(parse(idParam, req.params).id));
  });
  a.get('/courses/:id/lectures/:lectureId', async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    res.json(await admin.reviewLecture(p.id, p.lectureId));
  });
  a.post('/courses/:id/approve', async (req, res) => {
    const { note } = parse(z.object({ note: optText(2000) }), req.body ?? {});
    res.json(await admin.approveCourse(parse(idParam, req.params).id, note));
  });
  a.post('/courses/:id/reject', async (req, res) => {
    const { reason } = parse(z.object({ reason: text(2000) }), req.body ?? {});
    res.json(await admin.rejectCourse(parse(idParam, req.params).id, reason));
  });
  a.post('/courses/:id/publish', async (req, res) => {
    res.json(await admin.publishCourse(parse(idParam, req.params).id));
  });
  a.post('/courses/:id/unpublish', async (req, res) => {
    const { reason } = parse(z.object({ reason: optText(2000) }), req.body ?? {});
    res.json(await admin.unpublishCourse(parse(idParam, req.params).id, reason));
  });

  const categoryInput = z.object({
    name: text(120),
    slug: z.string().trim().max(120).optional(),
    parentId: optId,
    icon: optText(60),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  });
  a.post('/categories', async (req, res) => {
    res.status(201).json(await admin.saveCategory(null, parse(categoryInput, req.body)));
  });
  a.put('/categories/:id', async (req, res) => {
    res.json(await admin.saveCategory(parse(idParam, req.params).id, parse(categoryInput, req.body)));
  });
  a.delete('/categories/:id', async (req, res) => {
    res.json(await admin.deleteCategory(parse(idParam, req.params).id));
  });

  a.get('/settings', async (_req, res) => {
    res.json(await admin.getSettings());
  });
  a.put('/settings', async (req, res) => {
    const body = parse(
      z.object({
        commissionPercent: z.number().min(0).max(100).optional(),
        instructorSignupOpen: z.boolean().optional(),
      }),
      req.body,
    );
    res.json(await admin.updateSettings(body));
  });

  a.get('/sellers', async (req, res) => {
    const q = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        type: z.enum(['institute', 'instructor']).optional(),
      }),
      req.query,
    );
    res.json(await sellers.listSellers(q));
  });
  a.patch('/sellers/:id', async (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(['active', 'suspended']).optional(),
        commissionPercent: z.number().min(0).max(100).nullable().optional(),
      }),
      req.body,
    );
    res.json(await sellers.updateSellerAdmin(parse(idParam, req.params).id, body));
  });

  a.get('/coupons', async (_req, res) => {
    res.json(await coupons.listCoupons(null));
  });
  a.post('/coupons', async (req, res) => {
    res.status(201).json(await coupons.createCoupon(null, parse(couponInput, req.body)));
  });
  a.patch('/coupons/:id', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await coupons.updateCoupon(null, id, parse(couponInput.partial(), req.body)));
  });
  a.delete('/coupons/:id', async (req, res) => {
    await coupons.deleteCoupon(null, parse(idParam, req.params).id);
    res.status(204).end();
  });

  a.get('/ledger', async (req, res) => {
    const q = parse(
      z.object({
        sellerId: z.coerce.number().int().positive().optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req.query,
    );
    res.json(await admin.ledger(q));
  });

  api.use('/admin/marketplace', a);
}

export function marketplaceRoutes(api: Router) {
  engagementRoutes(api);
  publicRoutes(api);
  certificatePublicRoutes(api);
  quizAdminRoutes(api);
  adminRoutes(api);
  const instructor = studioRoutes('instructor', () => []);
  api.use('/marketplace/instructor', authenticate, instructor);
  const institute = studioRoutes('institute', (action) => [requirePermission(MARKETPLACE, action)]);
  api.use('/marketplace/institute', authenticate, institute);
  learnerRoutes(api);
  payoutRoutes(api);
}
