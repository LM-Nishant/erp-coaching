import type { MktCouponDto, MktCouponInput } from '@erp/shared';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { MktCoupon, MktCourse } from './models';
import { iso } from './util';

export const normaliseCode = (code: string) => code.trim().toUpperCase();

export function toCouponDto(c: MktCoupon): MktCouponDto {
  return {
    id: c.id,
    code: c.code,
    sellerId: c.sellerId,
    kind: c.kind,
    value: c.value,
    courseIds: c.courseIds ?? [],
    maxUses: c.maxUses,
    usedCount: c.usedCount,
    validFrom: iso(c.validFrom),
    validUntil: iso(c.validUntil),
    active: c.active,
  };
}

/** `sellerId` null = platform coupon (super admin). */
export async function listCoupons(sellerId: number | null): Promise<MktCouponDto[]> {
  const rows = await MktCoupon.findAll({ where: { sellerId }, order: [['id', 'DESC']] });
  return rows.map(toCouponDto);
}

async function couponFields(sellerId: number | null, input: Partial<MktCouponInput>) {
  if (input.kind === 'percent' && input.value !== undefined && (input.value < 1 || input.value > 100))
    throw BadRequest('A percentage discount must be between 1 and 100');
  if (input.courseIds?.length) {
    const where = sellerId ? { id: input.courseIds, sellerId } : { id: input.courseIds };
    if ((await MktCourse.count({ where })) !== new Set(input.courseIds).size) throw NotFound('Course');
  }
  const toDate = (v: string | Date | null | undefined): Date | null | undefined =>
    v ? new Date(v) : v === undefined ? undefined : null;
  const from = toDate(input.validFrom);
  const until = toDate(input.validUntil);
  if (from && until && until <= from) throw BadRequest('The end date must be after the start date');
  return {
    ...(input.code !== undefined && { code: normaliseCode(input.code) }),
    ...(input.kind !== undefined && { kind: input.kind }),
    ...(input.value !== undefined && { value: input.value }),
    ...(input.courseIds !== undefined && { courseIds: [...new Set(input.courseIds)] }),
    ...(input.maxUses !== undefined && { maxUses: input.maxUses }),
    ...(from !== undefined && { validFrom: from }),
    ...(until !== undefined && { validUntil: until }),
    ...(input.active !== undefined && { active: input.active }),
  };
}

const auditCoupon = (action: string, c: MktCoupon) =>
  audit({
    action: `marketplace.coupon.${action}`,
    entityType: 'mkt_coupon',
    entityId: c.id,
    instituteId: c.sellerId ? (getContext().instituteId ?? null) : null,
    metadata: { code: c.code },
  });

export async function createCoupon(sellerId: number | null, input: MktCouponInput): Promise<MktCouponDto> {
  const fields = await couponFields(sellerId, input);
  try {
    const c = await MktCoupon.create({
      sellerId,
      code: normaliseCode(input.code),
      kind: input.kind,
      value: input.value,
      courseIds: [],
      maxUses: null,
      validFrom: null,
      validUntil: null,
      createdByUserId: getContext().userId ?? null,
      ...fields,
    });
    await auditCoupon('created', c);
    return toCouponDto(c);
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError')
      throw Conflict('This coupon code is already taken', 'COUPON_CODE_TAKEN');
    throw err;
  }
}

export async function updateCoupon(sellerId: number | null, id: number, input: Partial<MktCouponInput>) {
  const c = await MktCoupon.findOne({ where: { id, sellerId } });
  if (!c) throw NotFound('Coupon');
  const kind = input.kind ?? c.kind;
  await c.update(await couponFields(sellerId, { ...input, kind, value: input.value ?? c.value }));
  await auditCoupon('updated', c);
  return toCouponDto(c);
}

export async function deleteCoupon(sellerId: number | null, id: number) {
  const c = await MktCoupon.findOne({ where: { id, sellerId } });
  if (!c) throw NotFound('Coupon');
  // Used coupons stay for order history; they are switched off instead.
  if (c.usedCount > 0) await c.update({ active: false });
  else await c.destroy();
  await auditCoupon('deleted', c);
}

export interface PricedItem {
  courseId: number;
  sellerId: number;
  pricePaise: number;
  discountPaise: number;
}

/**
 * Applies a coupon to cart items. Seller coupons cover that seller's courses, platform coupons
 * every course; either can be limited to listed courses. A fixed amount is spread over the
 * eligible items in proportion to their price. Returns the coupon, or a reason it does not apply.
 */
export async function applyCoupon(
  code: string | null | undefined,
  items: PricedItem[],
  now = new Date(),
): Promise<{ coupon: MktCoupon | null; message: string | null }> {
  for (const i of items) i.discountPaise = 0;
  if (!code?.trim()) return { coupon: null, message: null };
  const c = await MktCoupon.findOne({ where: { code: normaliseCode(code) } });
  const invalid = (message: string) => ({ coupon: null, message });
  if (!c || !c.active) return invalid('This coupon code is not valid');
  if ((c.validFrom && c.validFrom > now) || (c.validUntil && c.validUntil < now))
    return invalid('This coupon has expired or is not active yet');
  if (c.maxUses !== null && c.usedCount >= c.maxUses) return invalid('This coupon has been fully used');
  const eligible = items.filter(
    (i) =>
      i.pricePaise > 0 &&
      (c.sellerId === null || c.sellerId === i.sellerId) &&
      (!c.courseIds?.length || c.courseIds.includes(i.courseId)),
  );
  if (!eligible.length) return invalid('This coupon does not apply to the courses in your cart');
  if (c.kind === 'percent') {
    for (const i of eligible) i.discountPaise = Math.round((i.pricePaise * c.value) / 100);
  } else {
    const base = eligible.reduce((a, i) => a + i.pricePaise, 0);
    const total = Math.min(c.value, base);
    let left = total;
    eligible.forEach((i, n) => {
      const share = n === eligible.length - 1 ? left : Math.floor((total * i.pricePaise) / base);
      i.discountPaise = Math.min(share, i.pricePaise);
      left -= i.discountPaise;
    });
  }
  return { coupon: c, message: null };
}
