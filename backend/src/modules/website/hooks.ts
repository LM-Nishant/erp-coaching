/**
 * Extension points other modules plug into from their own `integrations.ts` (see CONTRIBUTING →
 * "Cross-module wiring"). Every hook has a safe default so the website works without them.
 */
import { logger } from '../../infrastructure/logger';

export interface CheckoutHandoffInput {
  instituteId: number;
  instituteSlug: string;
  courseId: number;
  batchId: number | null;
  couponCode: string | null;
  referralCode: string | null;
  /** Absolute URL the payment flow should return the visitor to. */
  returnUrl: string;
}

/** Returns the URL of the fees/payments checkout for a course, or null to fall back to admission. */
export type CheckoutHandoff = (input: CheckoutHandoffInput) => Promise<{ url: string } | null>;

/** Display price for a course on the public catalogue (e.g. "₹12,000"), or null to hide it. */
export type CoursePriceResolver = (courseIds: number[]) => Promise<Map<number, string>>;

let checkoutHandoff: CheckoutHandoff | null = null;
let coursePriceResolver: CoursePriceResolver | null = null;

/** Fees/payments registers its checkout here (called from its `integrations.ts`, in `onReady`). */
export function setCheckoutHandoff(fn: CheckoutHandoff | null) {
  checkoutHandoff = fn;
}

export function setCoursePriceResolver(fn: CoursePriceResolver | null) {
  coursePriceResolver = fn;
}

export async function resolveCheckout(input: CheckoutHandoffInput) {
  if (!checkoutHandoff) return null;
  try {
    return await checkoutHandoff(input);
  } catch (err) {
    logger.warn({ err, courseId: input.courseId }, 'website: checkout handoff failed, using admission');
    return null;
  }
}

export async function resolveCoursePrices(courseIds: number[]): Promise<Map<number, string>> {
  if (!coursePriceResolver || !courseIds.length) return new Map();
  try {
    return await coursePriceResolver(courseIds);
  } catch (err) {
    logger.warn({ err }, 'website: course price resolver failed');
    return new Map();
  }
}
