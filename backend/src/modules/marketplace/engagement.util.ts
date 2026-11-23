import { MktCourse, MktEnrolment, MktSeller } from './models';
import { LIVE } from './catalog.service';
import { NotFound } from '../../shared/errors';

/** Public display name: "Asha Verma" → "Asha V." (learners are not fully named in public). */
export function publicName(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Learner';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** A published course of an active seller, by id or slug. */
export async function liveCourse(where: { id: number } | { slug: string }) {
  const c = await MktCourse.findOne({
    where: { ...where, ...LIVE },
    include: [{ model: MktSeller, as: 'seller', where: { status: 'active' } }],
  });
  if (!c) throw NotFound('Course');
  return c;
}

export async function isEnrolled(userId: number | undefined, courseId: number) {
  if (!userId) return false;
  return (await MktEnrolment.count({ where: { userId, courseId } })) > 0;
}

/** Courses of a seller (for studio lists), keyed by id. */
export async function sellerCourses(sellerId: number) {
  const rows = await MktCourse.findAll({ where: { sellerId }, attributes: ['id', 'slug', 'title'] });
  return new Map(rows.map((c) => [c.id, { id: c.id, slug: c.slug, title: c.title }]));
}

export const courseRef = (c: MktCourse) => ({ id: c.id, slug: c.slug, title: c.title });
