import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { config } from '../../infrastructure/config';

const handler: RequestHandler = (_req, res) => {
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' } });
};

const limiterNames = new WeakMap<RequestHandler, string>();

/** The limiter's name when `fn` is one of these limiters (used by the route registry). */
export function rateLimiterName(fn: unknown): string | undefined {
  return typeof fn === 'function' ? limiterNames.get(fn as RequestHandler) : undefined;
}

/**
 * Each limiter keeps its own per-IP counter, so traffic of one kind (say a biometric device or
 * website forms behind an institute's NAT) can't use up another's budget (logins). Counters are
 * in memory, i.e. per API process; see docs/deployment.md for running several nodes.
 */
function limiter(
  name: string,
  windowMs: number,
  limit: number,
  skip?: (req: Parameters<RequestHandler>[0]) => boolean,
): RequestHandler {
  const fn: RequestHandler = config.RATE_LIMIT_ENABLED
    ? rateLimit({ windowMs, limit, skip, standardHeaders: 'draft-8', legacyHeaders: false, handler })
    : (_req, _res, next) => next();
  limiterNames.set(fn, name);
  return fn;
}

const MINUTE = 60_000;
const WINDOW_15M = 15 * MINUTE;
/** Token-authorised media (signed files, HLS) has its own, higher limit: a video is many requests. */
const MEDIA_PATH = /^\/(files\/signed|lms\/public\/hls)\//;

/** Every /api request except media. */
export const apiRateLimit = limiter('api', MINUTE, config.RATE_LIMIT_API_PER_MIN, (req) =>
  MEDIA_PATH.test(req.path),
);

/** Signed file downloads and HLS segments. */
export const mediaRateLimit = limiter('media', MINUTE, config.RATE_LIMIT_MEDIA_PER_MIN);

/** Password login and OTP request/verify: brute-force protection. */
export const authRateLimit = limiter('auth', WINDOW_15M, config.RATE_LIMIT_AUTH_MAX);

/** Refresh and logout. Tokens are unguessable, so this only curbs abuse; every app user refreshes. */
export const tokenRateLimit = limiter('token', WINDOW_15M, config.RATE_LIMIT_TOKEN_MAX);

/** Unauthenticated writes from public pages: enquiry forms, checkout, coupons, self-registration. */
export const publicFormRateLimit = limiter('public-form', WINDOW_15M, config.RATE_LIMIT_PUBLIC_FORM_MAX);

/** Biometric device pushes (authenticated by device serial and key). */
export const deviceRateLimit = limiter('device', MINUTE, config.RATE_LIMIT_DEVICE_PER_MIN);

/** ZKTeco/eSSL ADMS devices (`/iclock/*`, identified by registered serial number). */
export const admsRateLimit = limiter('adms', MINUTE, config.RATE_LIMIT_ADMS_PER_MIN);

/** Payment gateway webhooks (signature verified in the handler). */
export const webhookRateLimit = limiter('webhook', MINUTE, config.RATE_LIMIT_WEBHOOK_PER_MIN);
