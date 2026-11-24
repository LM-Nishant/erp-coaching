import { Op } from 'sequelize';
import type { MktInstructorProfileInput, MktSellerAdminDto, MktSellerRef } from '@erp/shared';
import { getContext, hasPermission } from '../../shared/context';
import { AppError, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { Institute } from '../institutes/institute.model';
import { MktCourse, MktMedia, MktSeller } from './models';
import { iso, platformSettings, uniqueSlug } from './util';
import { imageUrl } from './media.service';

/** Whose courses a builder request manages: the signed-in instructor, or the current institute. */
export type SellerScope = 'instructor' | 'institute';

export function sellerRef(s: MktSeller): MktSellerRef {
  return {
    id: s.id,
    slug: s.slug,
    displayName: s.displayName,
    type: s.type,
    avatarUrl: s.avatar ? imageUrl(s.avatar) : null,
  };
}

export async function toSellerAdminDto(s: MktSeller, courseCount?: number): Promise<MktSellerAdminDto> {
  return {
    ...sellerRef(s),
    headline: s.headline,
    bio: s.bio,
    website: s.website,
    status: s.status,
    instituteId: s.ownerInstituteId,
    commissionPercent: s.commissionPercent,
    courseCount: courseCount ?? (await MktCourse.count({ where: { sellerId: s.id } })),
    createdAt: iso(s.createdAt)!,
  };
}

const slugTaken = async (slug: string) => !!(await MktSeller.count({ where: { slug } }));
const withAvatar = { include: [{ model: MktMedia, as: 'avatar' }] };

export function instructorOf(userId: number) {
  return MktSeller.findOne({ where: { userId, type: 'instructor' }, ...withAvatar });
}

/**
 * The institute's storefront, created on first use with the institute's name. Every course the
 * institute sells belongs to it.
 */
export async function instituteSeller(instituteId: number): Promise<MktSeller> {
  const found = await MktSeller.findOne({ where: { ownerInstituteId: instituteId }, ...withAvatar });
  if (found) return found;
  const inst = await Institute.findByPk(instituteId);
  if (!inst) throw NotFound('Institute');
  try {
    await MktSeller.create({
      type: 'institute',
      slug: await uniqueSlug(inst.name, slugTaken),
      displayName: inst.name,
      headline: null,
      bio: null,
      website: null,
      avatarMediaId: null,
      ownerInstituteId: instituteId,
      userId: null,
      commissionPercent: null,
    });
  } catch (err) {
    if ((err as { name?: string }).name !== 'SequelizeUniqueConstraintError') throw err;
  }
  return (await MktSeller.findOne({ where: { ownerInstituteId: instituteId }, ...withAvatar }))!;
}

/** The seller the caller manages in `scope`; institute access is checked by the route's permission. */
export async function currentSeller(scope: SellerScope): Promise<MktSeller> {
  const ctx = getContext();
  let seller: MktSeller | null;
  if (scope === 'institute') {
    if (!ctx.instituteId) throw Forbidden('Select an institute first', 'INSTITUTE_REQUIRED');
    seller = await instituteSeller(ctx.instituteId);
  } else {
    seller = await instructorOf(ctx.userId!);
    if (!seller)
      throw new AppError(404, 'INSTRUCTOR_PROFILE_REQUIRED', 'Create your instructor profile first');
  }
  if (seller.status !== 'active')
    throw Forbidden('This seller account is suspended. Contact support.', 'SELLER_SUSPENDED');
  return seller;
}

/** Whether the caller may manage `sellerId` (own instructor profile, or institute storefront with permission). */
export async function managesSeller(sellerId: number): Promise<boolean> {
  const ctx = getContext();
  if (!ctx.userId) return false;
  const s = await MktSeller.findByPk(sellerId, { attributes: ['userId', 'ownerInstituteId'] });
  if (!s) return false;
  if (s.userId && s.userId === ctx.userId) return true;
  return !!s.ownerInstituteId && s.ownerInstituteId === ctx.instituteId && hasPermission('marketplace.view');
}

async function checkAvatar(sellerId: number, mediaId: number | null | undefined) {
  if (!mediaId) return null;
  const m = await MktMedia.findOne({ where: { id: mediaId, sellerId, kind: 'image', status: 'ready' } });
  if (!m) throw NotFound('Image');
  return m.id;
}

/** Creates or updates the signed-in user's independent instructor profile. */
export async function saveInstructorProfile(input: MktInstructorProfileInput): Promise<MktSellerAdminDto> {
  const { userId } = getContext();
  const existing = await instructorOf(userId!);
  const fields = {
    displayName: input.displayName,
    headline: input.headline ?? null,
    bio: input.bio ?? null,
    website: input.website ?? null,
  };
  if (existing) {
    await existing.update({ ...fields, avatarMediaId: await checkAvatar(existing.id, input.avatarMediaId) });
    await audit({
      action: 'marketplace.instructor.updated',
      entityType: 'mkt_seller',
      entityId: existing.id,
      instituteId: null,
    });
    return toSellerAdminDto((await instructorOf(userId!))!);
  }
  if (!(await platformSettings()).instructorSignupOpen)
    throw Forbidden('Instructor sign-up is closed at the moment', 'INSTRUCTOR_SIGNUP_CLOSED');
  const created = await MktSeller.create({
    ...fields,
    type: 'instructor',
    slug: await uniqueSlug(input.displayName, slugTaken),
    avatarMediaId: null,
    ownerInstituteId: null,
    userId: userId!,
    commissionPercent: null,
  });
  await audit({
    action: 'marketplace.instructor.created',
    entityType: 'mkt_seller',
    entityId: created.id,
    instituteId: null,
  });
  return toSellerAdminDto((await instructorOf(userId!))!, 0);
}

/** Institute storefront profile (name shown on courses, bio, avatar). */
export async function saveInstituteProfile(input: MktInstructorProfileInput): Promise<MktSellerAdminDto> {
  const seller = await currentSeller('institute');
  await seller.update({
    displayName: input.displayName,
    headline: input.headline ?? null,
    bio: input.bio ?? null,
    website: input.website ?? null,
    avatarMediaId: await checkAvatar(seller.id, input.avatarMediaId),
  });
  await audit({ action: 'marketplace.storefront.updated', entityType: 'mkt_seller', entityId: seller.id });
  return toSellerAdminDto((await instituteSeller(seller.ownerInstituteId!))!);
}

// ---------------------------------------------------------------- platform admin

export async function listSellers(q: { q?: string; type?: string }): Promise<MktSellerAdminDto[]> {
  const where: Record<string | symbol, unknown> = {};
  if (q.type) where.type = q.type;
  if (q.q) where.displayName = { [Op.like]: `%${q.q.replace(/[%_\\]/g, '\\$&')}%` };
  const rows = await MktSeller.findAll({ where, order: [['displayName', 'ASC']], limit: 500, ...withAvatar });
  return Promise.all(rows.map((s) => toSellerAdminDto(s)));
}

export async function updateSellerAdmin(
  id: number,
  input: { status?: 'active' | 'suspended'; commissionPercent?: number | null },
): Promise<MktSellerAdminDto> {
  const s = await MktSeller.findByPk(id, withAvatar);
  if (!s) throw NotFound('Seller');
  await s.update({
    ...(input.status !== undefined && { status: input.status }),
    ...(input.commissionPercent !== undefined && { commissionPercent: input.commissionPercent }),
  });
  await audit({
    action: 'marketplace.seller.updated',
    entityType: 'mkt_seller',
    entityId: id,
    instituteId: null,
    metadata: input,
  });
  return toSellerAdminDto(s);
}
