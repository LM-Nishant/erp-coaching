import { Op, type Transaction } from 'sequelize';
import { z } from 'zod';
import type { CouponDto, CouponValidationResult } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { Coupon, CouponRedemption } from './models';

export const couponRepo = new TenantRepository(Coupon, { entity: 'Coupon' });

export const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,40}$/, 'Use 3–40 letters, digits, - or _');

const money = z.number().min(0).max(10_000_000);

export const couponInputSchema = z
  .object({
    code: codeSchema,
    description: z.string().trim().max(255).nullable().optional(),
    discountType: z.enum(['percent', 'fixed']),
    discountValue: z.number().positive().max(10_000_000),
    maxDiscount: money.nullable().optional(),
    minAmount: money.nullable().optional(),
    validFrom: z.coerce.date().nullable().optional(),
    validUntil: z.coerce.date().nullable().optional(),
    usageLimit: z.number().int().positive().nullable().optional(),
    perCustomerLimit: z.number().int().positive().nullable().optional(),
    courseIds: z.array(z.number().int().positive()).max(200).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((c) => c.discountType !== 'percent' || c.discountValue <= 100, {
    message: 'A percentage discount cannot exceed 100',
    path: ['discountValue'],
  })
  .refine((c) => !c.validFrom || !c.validUntil || c.validFrom <= c.validUntil, {
    message: 'Valid until must be after valid from',
    path: ['validUntil'],
  });

const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));
const toPaise = (rupees: number | string | null) =>
  rupees === null ? null : Math.round(Number(rupees) * 100);

export function toCouponDto(c: Coupon): CouponDto {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    discountType: c.discountType,
    discountValue: Number(c.discountValue),
    maxDiscount: num(c.maxDiscount),
    minAmount: num(c.minAmount),
    validFrom: c.validFrom?.toISOString() ?? null,
    validUntil: c.validUntil?.toISOString() ?? null,
    usageLimit: c.usageLimit,
    perCustomerLimit: c.perCustomerLimit,
    usedCount: c.usedCount,
    courseIds: c.courseIds,
    isActive: c.isActive,
  };
}

export async function assertCodeFree(code: string, exceptId?: number) {
  const where: Record<string | symbol, unknown> = { code };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  if (await couponRepo.count(where)) throw Conflict('A coupon with this code already exists');
}

export interface ValidateCouponInput {
  code: string;
  /** Order amount before discount, in paise. */
  amountPaise: number;
  courseId?: number | null;
  /** Stable customer identifier (mobile, user id…) for per-customer limits. */
  customerKey?: string | null;
  now?: Date;
}

/** Discount for an amount, rounded to whole paise and never above the amount. */
export function computeDiscountPaise(c: Coupon, amountPaise: number) {
  let discount =
    c.discountType === 'percent'
      ? Math.floor((amountPaise * Number(c.discountValue)) / 100)
      : (toPaise(c.discountValue) ?? 0);
  const cap = toPaise(c.maxDiscount);
  if (c.discountType === 'percent' && cap !== null) discount = Math.min(discount, cap);
  return Math.max(0, Math.min(discount, amountPaise));
}

/**
 * Checks a coupon for the current institute (tenant context required) and computes the discount.
 * Never throws for an unusable code — returns `valid: false` with a `reason` instead. Fees/payments
 * calls this when building an order and `redeemCoupon()` once the payment is captured.
 */
export async function validateCoupon(
  input: ValidateCouponInput,
  opts: { transaction?: Transaction } = {},
): Promise<CouponValidationResult> {
  const code = input.code.trim().toUpperCase();
  const amount = Math.max(0, Math.round(input.amountPaise));
  const fail = (
    reason: CouponValidationResult['reason'],
    message: string,
    couponId: number | null = null,
  ) => ({
    valid: false,
    code,
    couponId,
    reason,
    message,
    discountPaise: 0,
    finalAmountPaise: amount,
  });
  const coupon = await couponRepo.findOne({ where: { code }, transaction: opts.transaction });
  if (!coupon) return fail('NOT_FOUND', 'This coupon code is not valid');
  const now = input.now ?? new Date();
  if (!coupon.isActive) return fail('INACTIVE', 'This coupon is no longer active', coupon.id);
  if (coupon.validFrom && coupon.validFrom > now)
    return fail('NOT_STARTED', 'This coupon is not active yet', coupon.id);
  if (coupon.validUntil && coupon.validUntil < now)
    return fail('EXPIRED', 'This coupon has expired', coupon.id);
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit)
    return fail('USAGE_LIMIT', 'This coupon has been fully used', coupon.id);
  if (coupon.courseIds?.length && (!input.courseId || !coupon.courseIds.includes(input.courseId)))
    return fail('COURSE_NOT_ELIGIBLE', 'This coupon does not apply to this course', coupon.id);
  const min = toPaise(coupon.minAmount);
  if (min !== null && amount < min)
    return fail('MIN_AMOUNT', `This coupon needs a minimum order of ₹${(min / 100).toFixed(2)}`, coupon.id);
  if (coupon.perCustomerLimit !== null && input.customerKey) {
    const used = await CouponRedemption.count({
      where: {
        instituteId: coupon.instituteId,
        couponId: coupon.id,
        customerKey: input.customerKey,
        status: 'redeemed',
      },
      transaction: opts.transaction,
    });
    if (used >= coupon.perCustomerLimit)
      return fail('CUSTOMER_LIMIT', 'You have already used this coupon', coupon.id);
  }
  const discount = computeDiscountPaise(coupon, amount);
  return {
    valid: true,
    code,
    couponId: coupon.id,
    reason: null,
    message: `Coupon applied: ₹${(discount / 100).toFixed(2)} off`,
    discountPaise: discount,
    finalAmountPaise: amount - discount,
  };
}

/**
 * Records a redemption for a paid order. Idempotent per `orderRef`; the global usage limit is
 * enforced atomically so concurrent checkouts cannot exceed it. Throws 409 when no longer valid.
 */
export async function redeemCoupon(
  input: ValidateCouponInput & { orderRef: string },
  opts: { transaction?: Transaction } = {},
): Promise<CouponValidationResult> {
  const run = async (transaction: Transaction) => {
    const { instituteId } = requireTenantContext();
    const code = input.code.trim().toUpperCase();
    const coupon = await couponRepo.findOne({ where: { code }, transaction, lock: transaction.LOCK.UPDATE });
    if (coupon) {
      const existing = await CouponRedemption.findOne({
        where: { instituteId, couponId: coupon.id, orderRef: input.orderRef },
        transaction,
      });
      if (existing?.status === 'redeemed') {
        const amount = Number(existing.amountPaise);
        const discount = Number(existing.discountPaise);
        return {
          valid: true,
          code,
          couponId: coupon.id,
          reason: null,
          message: 'Coupon already redeemed for this order',
          discountPaise: discount,
          finalAmountPaise: amount - discount,
        } satisfies CouponValidationResult;
      }
    }
    const result = await validateCoupon(input, { transaction });
    if (!result.valid || !coupon) throw Conflict(result.message, `COUPON_${result.reason}`);
    const [affected] = await Coupon.update(
      { usedCount: getSequelize().literal('used_count + 1') as unknown as number },
      {
        where: {
          instituteId,
          id: coupon.id,
          ...(coupon.usageLimit !== null ? { usedCount: { [Op.lt]: coupon.usageLimit } } : {}),
        },
        transaction,
      },
    );
    if (!affected) throw Conflict('This coupon has been fully used', 'COUPON_USAGE_LIMIT');
    const values = {
      customerKey: input.customerKey ?? null,
      amountPaise: Math.round(input.amountPaise),
      discountPaise: result.discountPaise,
      status: 'redeemed' as const,
    };
    const existing = await CouponRedemption.findOne({
      where: { instituteId, couponId: coupon.id, orderRef: input.orderRef },
      transaction,
    });
    if (existing) await existing.update(values, { transaction });
    else
      await CouponRedemption.create(
        { instituteId, couponId: coupon.id, orderRef: input.orderRef, ...values },
        { transaction },
      );
    return result;
  };
  return opts.transaction ? run(opts.transaction) : getSequelize().transaction(run);
}

/** Gives a use back (refund / cancelled order). Idempotent. */
export async function releaseCoupon(
  input: { code: string; orderRef: string },
  opts: { transaction?: Transaction } = {},
) {
  const run = async (transaction: Transaction) => {
    const { instituteId } = requireTenantContext();
    const coupon = await couponRepo.findOne({
      where: { code: input.code.trim().toUpperCase() },
      transaction,
    });
    if (!coupon) throw BadRequest('Unknown coupon');
    const r = await CouponRedemption.findOne({
      where: { instituteId, couponId: coupon.id, orderRef: input.orderRef, status: 'redeemed' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!r) return false;
    await r.update({ status: 'released' }, { transaction });
    await Coupon.update(
      { usedCount: getSequelize().literal('GREATEST(used_count, 1) - 1') as unknown as number },
      { where: { instituteId, id: coupon.id }, transaction },
    );
    return true;
  };
  return opts.transaction ? run(opts.transaction) : getSequelize().transaction(run);
}
