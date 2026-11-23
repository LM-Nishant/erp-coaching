import type { Response } from 'express';
import type { CheckoutPlatform, CheckoutReturnInput } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { hmac, safeEqual } from '../../infrastructure/crypto';

/**
 * Redirect-based checkouts (the native apps, and some payment methods on the web) end with the
 * gateway sending the payer's browser to a URL we chose. That URL is a signed link to the API: it
 * re-checks the payment with the gateway (whatever the gateway posted is never trusted) and then
 * sends the payer back into the app they came from: the web app, the Android app's
 * `https://localhost` origin, or `capacitor://localhost` on iOS. Links expire after a week.
 */
export type CheckoutReturnScope = 'fees' | 'saas' | 'marketplace';

export interface CheckoutReturnTarget {
  instituteId: number | null;
  paymentId: number;
  platform: CheckoutPlatform;
  path: string;
}

const PLATFORM_CODES: Record<CheckoutPlatform, string> = { web: 'w', android: 'a', ios: 'i' };
const TTL_SECONDS = 7 * 24 * 60 * 60;
// Short enough to keep the whole link under Cashfree's 250-character return_url limit.
const PATH_RE = /^\/[A-Za-z0-9/_-]{0,60}$/;
const SIGNATURE_LENGTH = 22;

const secretFor = (scope: CheckoutReturnScope) => `${config.FILE_URL_SECRET}:checkout-return:${scope}`;
const sign = (scope: CheckoutReturnScope, payload: string) =>
  hmac(payload, secretFor(scope)).slice(0, SIGNATURE_LENGTH);

/** `path` when it is a plain in-app path (`/my-fees`), else `fallback`. */
export function checkoutReturnPath(path: string | undefined, fallback: string): string {
  return path && PATH_RE.test(path) && !path.includes('//') ? path : fallback;
}

export function signCheckoutReturn(
  scope: CheckoutReturnScope,
  target: CheckoutReturnTarget,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify([
      target.instituteId,
      target.paymentId,
      PLATFORM_CODES[target.platform],
      target.path,
      Math.floor(now / 1000) + TTL_SECONDS,
    ]),
  ).toString('base64url');
  return `${payload}.${sign(scope, payload)}`;
}

export function verifyCheckoutReturn(
  scope: CheckoutReturnScope,
  token: string,
  now = Date.now(),
): CheckoutReturnTarget | null {
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length || !safeEqual(signature, sign(scope, payload))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) return null;
  const [instituteId, paymentId, code, path, expires] = parsed as unknown[];
  const platform = (Object.keys(PLATFORM_CODES) as CheckoutPlatform[]).find(
    (p) => PLATFORM_CODES[p] === code,
  );
  if (
    (instituteId !== null && !Number.isSafeInteger(instituteId)) ||
    !Number.isSafeInteger(paymentId) ||
    !platform ||
    typeof path !== 'string' ||
    checkoutReturnPath(path, '') !== path ||
    typeof expires !== 'number' ||
    expires * 1000 < now
  ) {
    return null;
  }
  return { instituteId: instituteId as number | null, paymentId: paymentId as number, platform, path };
}

const CHECKOUT_RETURN_BASES: Record<CheckoutReturnScope, string> = {
  fees: '/api/fees',
  saas: '/api/subscriptions',
  marketplace: '/api/marketplace',
};

/** Absolute API URL the gateway sends the payer to once checkout ends. */
export function checkoutReturnUrl(
  scope: CheckoutReturnScope,
  ids: { instituteId: number | null; paymentId: number },
  returnTo: CheckoutReturnInput | undefined,
  defaultPath: string,
): string {
  const token = signCheckoutReturn(scope, {
    ...ids,
    platform: returnTo?.platform ?? 'web',
    path: checkoutReturnPath(returnTo?.path, defaultPath),
  });
  const base = CHECKOUT_RETURN_BASES[scope];
  return `${config.API_PUBLIC_URL}${base}/public/checkout-return/${token}`;
}

/** Where the payer lands in the app (`?payment=<id>` tells the page to re-check that payment). */
export function checkoutReturnDestination(target: CheckoutReturnTarget): string {
  const suffix = `${target.path}?payment=${target.paymentId}`;
  if (target.platform === 'android') return `https://localhost${suffix}`;
  if (target.platform === 'ios') return `capacitor://localhost${suffix}`;
  return `${config.publicWebUrl}${suffix}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(message: string, url?: string): string {
  const link = url ? `<p><a href="${escapeHtml(url)}">Return to the app</a></p>` : '';
  const refresh = url ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(url)}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>Payment</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px"><p>${escapeHtml(message)}</p>${link}</body></html>`;
}

/**
 * Sends the payer back to the app. iOS gets a page that opens `capacitor://localhost`, with a link
 * as a fallback, instead of an HTTP redirect to a custom scheme.
 */
export function sendCheckoutReturn(res: Response, target: CheckoutReturnTarget | null): void {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  if (!target) {
    res
      .status(400)
      .type('html')
      .send(page('This payment link is invalid or has expired. Open the app to see the payment status.'));
    return;
  }
  const url = checkoutReturnDestination(target);
  if (target.platform !== 'ios') {
    res.redirect(303, url);
    return;
  }
  res.status(200).type('html').send(page('Returning to the app…', url));
}
