/**
 * Public surface of the website module for other modules (fees/payments, students…). Import from
 * here only. All functions run in the caller's tenant context.
 *
 * Fees/payments wiring (from its own `integrations.ts`, in `onReady`):
 *   - `setCheckoutHandoff(fn)`: return the checkout URL for a course (website "Enrol online" buttons
 *     and `/api/public/sites/:site/checkout/:courseId` hand off to it; falls back to online admission).
 *   - `setCoursePriceResolver(fn)`: display prices on the public course catalogue.
 *   - `validateCoupon()` when pricing an order, `redeemCoupon()` once payment is captured
 *     (idempotent per orderRef), `releaseCoupon()` on refund/cancellation.
 *   - `recordReferralConversion({ kind: 'purchase', ... })` with the order's referral code.
 */
export {
  validateCoupon,
  redeemCoupon,
  releaseCoupon,
  computeDiscountPaise,
  type ValidateCouponInput,
} from './coupons.service';
export { recordReferralConversion } from './referrals.service';
export {
  setCheckoutHandoff,
  setCoursePriceResolver,
  type CheckoutHandoff,
  type CheckoutHandoffInput,
  type CoursePriceResolver,
} from './hooks';
export { Coupon, CouponRedemption, ReferralCode } from './models';
