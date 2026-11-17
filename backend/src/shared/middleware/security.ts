import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { config } from '../../infrastructure/config';

const passthrough: RequestHandler = (_req, _res, next) => next();
const handler: RequestHandler = (_req, res) => {
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' } });
};

export const apiRateLimit: RequestHandler = config.RATE_LIMIT_ENABLED
  ? rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false, handler })
  : passthrough;

/** Stricter limit for login/OTP endpoints. */
export const authRateLimit: RequestHandler = config.RATE_LIMIT_ENABLED
  ? rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, handler })
  : passthrough;
