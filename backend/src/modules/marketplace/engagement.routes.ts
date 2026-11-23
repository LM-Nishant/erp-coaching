import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  MKT_QA_MAX_BODY,
  MKT_REVIEW_MAX_BODY,
  MKT_REVIEW_SORTS,
  MKT_REVIEW_STATUSES,
  type PermissionAction,
} from '@erp/shared';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { idParam } from '../../shared/utilities/pagination';
import { parse } from '../../shared/utilities/validation';
import * as qa from './qa.service';
import * as reviews from './reviews.service';
import * as sellers from './sellers.service';
import * as wishlist from './wishlist.service';
import { MARKETPLACE } from './util';

/** Ratings & reviews, course Q&A and the wishlist (wave 2). Registered before the other marketplace routes. */

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const ids = (...names: string[]) =>
  z.object(Object.fromEntries(names.map((n) => [n, z.coerce.number().int().positive()])));
const pageQuery = {
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
};
const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
const reviewInput = z.object({
  rating: z.number().int().min(1).max(5),
  title: optText(150),
  body: optText(MKT_REVIEW_MAX_BODY),
});
const questionQuery = z.object({
  lectureId: z.coerce.number().int().positive().optional(),
  filter: z.enum(['all', 'unanswered', 'mine']).optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});
const questionInput = z.object({
  title: text(200),
  body: optText(MKT_QA_MAX_BODY),
  lectureId: z.number().int().positive().nullable().optional(),
});
const answerInput = z.object({ body: text(MKT_QA_MAX_BODY) });
const answeredInput = z.object({ answered: z.boolean() });
const courseParam = ids('id');
const questionParams = ids('id', 'questionId');

function publicRoutes(api: Router) {
  api.get('/marketplace/public/courses/:slug/reviews', async (req, res) => {
    const { slug } = parse(z.object({ slug: z.string().trim().min(1).max(120) }), req.params);
    const q = parse(
      z.object({
        sort: z.enum(MKT_REVIEW_SORTS).optional(),
        rating: z.coerce.number().int().min(1).max(5).optional(),
        ...pageQuery,
      }),
      req.query,
    );
    res.json(await reviews.listCourseReviews(slug, q));
  });
}

/** Signed-in learners. Authentication is per route: these share the `/marketplace` prefix with public routes. */
function learnerRoutes(api: Router) {
  const r = Router();
  const auth = authenticate;

  r.get('/courses/:id/reviews/me', auth, async (req, res) => {
    res.json(await reviews.myReview(parse(courseParam, req.params).id));
  });
  r.put('/courses/:id/reviews/me', auth, async (req, res) => {
    res.json(await reviews.saveReview(parse(courseParam, req.params).id, parse(reviewInput, req.body)));
  });
  r.delete('/courses/:id/reviews/me', auth, async (req, res) => {
    await reviews.deleteReview(parse(courseParam, req.params).id);
    res.status(204).end();
  });
  r.post('/reviews/:id/report', auth, async (req, res) => {
    const { reason } = parse(z.object({ reason: text(500) }), req.body ?? {});
    res.json(await reviews.reportReview(parse(idParam, req.params).id, reason));
  });

  r.get('/courses/:id/questions', auth, async (req, res) => {
    res.json(await qa.listQuestions(parse(courseParam, req.params).id, parse(questionQuery, req.query)));
  });
  r.post('/courses/:id/questions', auth, async (req, res) => {
    const { id } = parse(courseParam, req.params);
    res.status(201).json(await qa.askQuestion(id, parse(questionInput, req.body)));
  });
  r.get('/courses/:id/questions/:questionId', auth, async (req, res) => {
    const p = parse(questionParams, req.params);
    res.json(await qa.getQuestion(p.id, p.questionId));
  });
  r.delete('/courses/:id/questions/:questionId', auth, async (req, res) => {
    const p = parse(questionParams, req.params);
    await qa.deleteQuestion(p.id, p.questionId);
    res.status(204).end();
  });
  r.post('/courses/:id/questions/:questionId/answers', auth, async (req, res) => {
    const p = parse(questionParams, req.params);
    res.status(201).json(await qa.answerQuestion(p.id, p.questionId, parse(answerInput, req.body).body));
  });
  r.delete('/courses/:id/questions/:questionId/answers/:answerId', auth, async (req, res) => {
    const p = parse(ids('id', 'questionId', 'answerId'), req.params);
    await qa.deleteAnswer(p.id, p.questionId, p.answerId);
    res.status(204).end();
  });
  r.put('/courses/:id/questions/:questionId/answered', auth, async (req, res) => {
    const p = parse(questionParams, req.params);
    res.json(await qa.setAnswered(p.id, p.questionId, parse(answeredInput, req.body).answered));
  });

  r.get('/wishlist', auth, async (_req, res) => {
    res.json(await wishlist.getWishlist());
  });
  r.get('/wishlist/ids', auth, async (_req, res) => {
    res.json({ courseIds: await wishlist.wishlistIds() });
  });
  r.post('/wishlist', auth, async (req, res) => {
    const { courseId } = parse(z.object({ courseId: z.number().int().positive() }), req.body);
    res.status(201).json(await wishlist.addToWishlist(courseId));
  });
  r.delete('/wishlist/:id', auth, async (req, res) => {
    res.json(await wishlist.removeFromWishlist(parse(idParam, req.params).id));
  });
  r.post('/wishlist/:id/move-to-cart', auth, async (req, res) => {
    res.json(await wishlist.moveToCart(parse(idParam, req.params).id));
  });

  api.use('/marketplace', r);
}

type Guard = (action: PermissionAction) => RequestHandler[];

/** Seller inbox for reviews and questions, mounted for instructors and institute storefronts. */
function studioRoutes(scope: sellers.SellerScope, can: Guard): Router {
  const r = Router();
  const seller = async () => (await sellers.currentSeller(scope)).id;

  r.get('/reviews', ...can('view'), async (req, res) => {
    const q = parse(
      z.object({ courseId: z.coerce.number().int().positive().optional(), unreplied: flag, ...pageQuery }),
      req.query,
    );
    res.json(await reviews.sellerReviews(await seller(), q));
  });
  r.put('/reviews/:id/reply', ...can('edit'), async (req, res) => {
    const { body } = parse(z.object({ body: optText(MKT_REVIEW_MAX_BODY) }), req.body ?? {});
    res.json(await reviews.replyToReview(await seller(), parse(idParam, req.params).id, body || null));
  });
  r.get('/questions', ...can('view'), async (req, res) => {
    const q = parse(
      questionQuery.extend({ courseId: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    res.json(await qa.sellerQuestions(await seller(), q));
  });
  r.post('/questions/:id/answers', ...can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.status(201).json(await qa.sellerAnswer(await seller(), id, parse(answerInput, req.body).body));
  });
  r.put('/questions/:id/answered', ...can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await qa.sellerSetAnswered(await seller(), id, parse(answeredInput, req.body).answered));
  });
  return r;
}

function adminRoutes(api: Router) {
  const a = Router();
  a.use(authenticate, requireSuperAdmin);
  a.get('/reviews', async (req, res) => {
    const q = parse(
      z.object({
        status: z.enum(MKT_REVIEW_STATUSES).optional(),
        reported: flag,
        courseId: z.coerce.number().int().positive().optional(),
        ...pageQuery,
      }),
      req.query,
    );
    res.json(await reviews.adminReviews(q));
  });
  a.post('/reviews/:id/hide', async (req, res) => {
    const { reason } = parse(z.object({ reason: optText(500) }), req.body ?? {});
    res.json(await reviews.moderateReview(parse(idParam, req.params).id, true, reason));
  });
  a.post('/reviews/:id/unhide', async (req, res) => {
    res.json(await reviews.moderateReview(parse(idParam, req.params).id, false));
  });
  api.use('/admin/marketplace', a);
}

export function engagementRoutes(api: Router) {
  publicRoutes(api);
  learnerRoutes(api);
  api.use(
    '/marketplace/instructor',
    authenticate,
    studioRoutes('instructor', () => []),
  );
  api.use(
    '/marketplace/institute',
    authenticate,
    studioRoutes('institute', (action) => [requirePermission(MARKETPLACE, action)]),
  );
  adminRoutes(api);
}
