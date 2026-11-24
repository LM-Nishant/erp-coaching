import type { MktWishlistDto } from '@erp/shared';
import { getContext } from '../../shared/context';
import { NotFound } from '../../shared/errors';
import { addToCart } from './commerce.service';
import { cardInclude, toCard } from './courses.service';
import { MktWishlistItem } from './engagement.models';
import { liveCourse } from './engagement.util';
import { MktCourse } from './models';

const me = () => getContext().userId!;

/** Saved courses, newest first; courses taken off sale stay hidden until they are back. */
export async function getWishlist(): Promise<MktWishlistDto> {
  const rows = await MktWishlistItem.findAll({
    where: { userId: me() },
    include: [{ model: MktCourse, as: 'course', where: { status: 'published' }, include: cardInclude }],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  return { items: rows.filter((r) => r.course?.seller?.status === 'active').map((r) => toCard(r.course!)) };
}

export async function wishlistIds(): Promise<number[]> {
  const rows = await MktWishlistItem.findAll({ where: { userId: me() }, attributes: ['courseId'] });
  return rows.map((r) => r.courseId);
}

export async function addToWishlist(courseId: number) {
  const userId = me();
  await liveCourse({ id: courseId });
  await MktWishlistItem.findOrCreate({ where: { userId, courseId }, defaults: { userId, courseId } });
  return { courseIds: await wishlistIds() };
}

export async function removeFromWishlist(courseId: number) {
  await MktWishlistItem.destroy({ where: { userId: me(), courseId } });
  return { courseIds: await wishlistIds() };
}

/** Moves a paid course into the cart (Udemy-style); it leaves the wishlist once it is in the cart. */
export async function moveToCart(courseId: number) {
  const item = await MktWishlistItem.findOne({ where: { userId: me(), courseId } });
  if (!item) throw NotFound('Wishlist item');
  const cart = await addToCart(courseId);
  await item.destroy();
  return cart;
}
