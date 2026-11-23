import { Op, fn, col, type Transaction, type WhereOptions } from 'sequelize';
import type {
  MktCourseReviewDto,
  MktManagedReviewDto,
  MktMyReviewDto,
  MktPage,
  MktRatingBreakdown,
  MktReviewInput,
  MktReviewListDto,
  MktReviewSort,
  MktReviewStatus,
  MktReviewSummaryDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { audit } from '../../shared/audit/audit.service';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { User } from '../users/user.model';
import { MktReview, MktReviewReport } from './engagement.models';
import { courseRef, isEnrolled, liveCourse, publicName } from './engagement.util';
import { MktCourse, MktSeller } from './models';
import { iso } from './util';

const me = () => getContext().userId!;
const withUser = () => ({ model: User, as: 'user', attributes: ['id', 'name'] });

const SORTS: Record<MktReviewSort, [string, 'ASC' | 'DESC'][]> = {
  recent: [
    ['createdAt', 'DESC'],
    ['id', 'DESC'],
  ],
  highest: [
    ['rating', 'DESC'],
    ['createdAt', 'DESC'],
  ],
  lowest: [
    ['rating', 'ASC'],
    ['createdAt', 'DESC'],
  ],
};

function toDto(r: MktReview, sellerName: string | null): MktCourseReviewDto {
  return {
    id: r.id,
    courseId: r.courseId,
    rating: r.rating,
    title: r.title,
    body: r.body,
    authorName: publicName(r.user?.name),
    mine: r.userId === getContext().userId,
    reply:
      r.replyBody && r.repliedAt
        ? { body: r.replyBody, sellerName: sellerName ?? 'Instructor', repliedAt: iso(r.repliedAt)! }
        : null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

/** Keeps `mkt_courses.rating_avg / rating_count` equal to the course's visible reviews. */
export async function recomputeRating(courseId: number, transaction?: Transaction) {
  const row = (await MktReview.findOne({
    where: { courseId, status: 'visible' },
    attributes: [
      [fn('COUNT', col('id')), 'n'],
      [fn('AVG', col('rating')), 'avg'],
    ],
    raw: true,
    transaction,
  })) as unknown as { n: number | string; avg: number | string | null } | null;
  const ratingCount = Number(row?.n ?? 0);
  const ratingAvg = ratingCount ? Math.round(Number(row?.avg ?? 0) * 100) / 100 : 0;
  await MktCourse.update({ ratingAvg, ratingCount }, { where: { id: courseId }, transaction, silent: true });
  return { ratingAvg, ratingCount };
}

async function breakdown(courseId: number): Promise<MktRatingBreakdown> {
  const rows = (await MktReview.findAll({
    where: { courseId, status: 'visible' },
    attributes: ['rating', [fn('COUNT', col('id')), 'n']],
    group: ['rating'],
    raw: true,
  })) as unknown as { rating: number; n: number | string }[];
  const out: MktRatingBreakdown = [0, 0, 0, 0, 0];
  for (const r of rows) if (r.rating >= 1 && r.rating <= 5) out[r.rating - 1] = Number(r.n);
  return out;
}

// ---------------------------------------------------------------- public / learner

export async function listCourseReviews(
  slug: string,
  q: { sort?: MktReviewSort; rating?: number; page?: number; pageSize?: number },
): Promise<MktReviewListDto> {
  const course = await liveCourse({ slug });
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 10;
  const where: WhereOptions = {
    courseId: course.id,
    status: 'visible',
    ...(q.rating ? { rating: q.rating } : {}),
  };
  const [{ rows, count }, bars] = await Promise.all([
    MktReview.findAndCountAll({
      where,
      include: [withUser()],
      order: SORTS[q.sort ?? 'recent'],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    breakdown(course.id),
  ]);
  const summary: MktReviewSummaryDto = {
    ratingAvg: course.ratingAvg,
    ratingCount: course.ratingCount,
    breakdown: bars,
  };
  return {
    items: rows.map((r) => toDto(r, course.seller?.displayName ?? null)),
    total: count,
    page,
    pageSize,
    summary,
  };
}

async function ownReview(courseId: number) {
  return MktReview.findOne({ where: { courseId, userId: me() }, include: [withUser()] });
}

async function sellerNameOf(courseId: number) {
  const c = await MktCourse.findByPk(courseId, {
    attributes: ['id', 'sellerId'],
    include: [{ model: MktSeller, as: 'seller', attributes: ['displayName'] }],
  });
  return c?.seller?.displayName ?? null;
}

export async function myReview(courseId: number): Promise<MktMyReviewDto> {
  const [canReview, review] = await Promise.all([isEnrolled(me(), courseId), ownReview(courseId)]);
  return { canReview, review: review ? toDto(review, await sellerNameOf(courseId)) : null };
}

/** One review per enrolled learner and course; saving again edits it. */
export async function saveReview(courseId: number, input: MktReviewInput): Promise<MktMyReviewDto> {
  const userId = me();
  if (!(await isEnrolled(userId, courseId)))
    throw Forbidden('Only learners enrolled in this course can review it', 'NOT_ENROLLED');
  const fields = {
    rating: input.rating,
    title: input.title?.trim() || null,
    body: input.body?.trim() || null,
  };
  await getSequelize().transaction(async (transaction) => {
    const existing = await MktReview.findOne({ where: { courseId, userId }, transaction, lock: true });
    if (existing) await existing.update(fields, { transaction });
    else {
      try {
        await MktReview.create({ courseId, userId, ...fields }, { transaction });
      } catch (err) {
        if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError')
          throw Conflict('You already reviewed this course', 'REVIEW_EXISTS');
        throw err;
      }
    }
    await recomputeRating(courseId, transaction);
  });
  return myReview(courseId);
}

export async function deleteReview(courseId: number) {
  await getSequelize().transaction(async (transaction) => {
    const r = await MktReview.findOne({ where: { courseId, userId: me() }, transaction });
    if (!r) throw NotFound('Review');
    await MktReviewReport.destroy({ where: { reviewId: r.id }, transaction });
    await r.destroy({ transaction });
    await recomputeRating(courseId, transaction);
  });
}

/** Any signed-in user may flag a review once; admins see flagged reviews first. */
export async function reportReview(id: number, reason: string) {
  const userId = me();
  const r = await MktReview.findByPk(id);
  if (!r || r.status !== 'visible') throw NotFound('Review');
  if (r.userId === userId) throw BadRequest('You cannot report your own review');
  const [, created] = await MktReviewReport.findOrCreate({
    where: { reviewId: id, userId },
    defaults: { reviewId: id, userId, reason },
  });
  if (created) await MktReview.increment('reportCount', { where: { id } });
  return { reported: true };
}

// ---------------------------------------------------------------- studio (seller) and admin

async function managedDtos(rows: MktReview[]): Promise<MktManagedReviewDto[]> {
  const courseIds = [...new Set(rows.map((r) => r.courseId))];
  const courses = courseIds.length
    ? await MktCourse.findAll({
        where: { id: courseIds },
        attributes: ['id', 'slug', 'title', 'sellerId'],
        include: [{ model: MktSeller, as: 'seller', attributes: ['displayName'] }],
      })
    : [];
  return rows.map((r) => {
    const c = courses.find((x) => x.id === r.courseId)!;
    return {
      ...toDto(r, c?.seller?.displayName ?? null),
      course: courseRef(c),
      status: r.status,
      reportCount: r.reportCount,
      hiddenReason: r.hiddenReason,
      reports: (r.reports ?? []).map((p) => ({ reason: p.reason, createdAt: iso(p.createdAt)! })),
    };
  });
}

async function pageOf(
  where: WhereOptions,
  q: { page?: number; pageSize?: number },
  order: [string, 'ASC' | 'DESC'][],
): Promise<MktPage<MktManagedReviewDto>> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  const { rows, count } = await MktReview.findAndCountAll({
    where,
    include: [withUser(), { model: MktReviewReport, as: 'reports', attributes: ['reason', 'createdAt'] }],
    order,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true,
  });
  return { items: await managedDtos(rows), total: count, page, pageSize };
}

export async function sellerReviews(
  sellerId: number,
  q: { courseId?: number; unreplied?: boolean; page?: number; pageSize?: number },
) {
  const courseIds = (await MktCourse.findAll({ where: { sellerId }, attributes: ['id'] })).map((c) => c.id);
  const ids = q.courseId ? courseIds.filter((id) => id === q.courseId) : courseIds;
  return pageOf(
    { courseId: ids, status: 'visible', ...(q.unreplied ? { replyBody: null } : {}) },
    q,
    SORTS.recent,
  );
}

/** The seller's public reply under a review; `null` removes it. */
export async function replyToReview(sellerId: number, id: number, body: string | null) {
  const r = await MktReview.findByPk(id);
  const c = r ? await MktCourse.findByPk(r.courseId, { attributes: ['id', 'sellerId'] }) : null;
  if (!r || !c || c.sellerId !== sellerId) throw NotFound('Review');
  await r.update(
    body
      ? { replyBody: body, replyByUserId: me(), repliedAt: new Date() }
      : { replyBody: null, replyByUserId: null, repliedAt: null },
  );
  const [dto] = await pageOf({ id }, {}, SORTS.recent).then((p) => p.items);
  return dto;
}

export async function adminReviews(q: {
  status?: MktReviewStatus;
  reported?: boolean;
  courseId?: number;
  page?: number;
  pageSize?: number;
}) {
  const where: WhereOptions = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.reported ? { reportCount: { [Op.gt]: 0 } } : {}),
    ...(q.courseId ? { courseId: q.courseId } : {}),
  };
  return pageOf(where, q, [['reportCount', 'DESC'], ...SORTS.recent]);
}

/** Hidden reviews drop out of the course page and its rating. */
export async function moderateReview(id: number, hide: boolean, reason?: string | null) {
  const r = await MktReview.findByPk(id);
  if (!r) throw NotFound('Review');
  await getSequelize().transaction(async (transaction) => {
    await r.update(
      hide
        ? { status: 'hidden', hiddenReason: reason ?? null, hiddenAt: new Date() }
        : { status: 'visible', hiddenReason: null, hiddenAt: null, reportCount: 0 },
      { transaction },
    );
    if (!hide) await MktReviewReport.destroy({ where: { reviewId: id }, transaction });
    await recomputeRating(r.courseId, transaction);
  });
  await audit({
    action: hide ? 'marketplace.review.hidden' : 'marketplace.review.restored',
    entityType: 'mkt_review',
    entityId: id,
    instituteId: null,
    metadata: reason ? { reason } : undefined,
  });
  const [dto] = await pageOf({ id }, {}, SORTS.recent).then((p) => p.items);
  return dto;
}
