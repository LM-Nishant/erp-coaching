import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext, type RequestContext } from '../context';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
      /** Exact request bytes of JSON bodies (webhook signature verification). */
      rawBody?: Buffer;
    }
  }
}

/** Creates the per-request context (AsyncLocalStorage). Must run after body parsers. */
export const contextMiddleware: RequestHandler = (req, res, next) => {
  const ctx: RequestContext = {
    requestId: (req.header('x-request-id') ?? crypto.randomUUID()).slice(0, 64),
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
  req.ctx = ctx;
  res.setHeader('X-Request-Id', ctx.requestId!);
  runWithContext(ctx, () => next());
};

/**
 * Re-enters the request context after middleware whose callbacks run outside it
 * (e.g. multer/busboy stream events).
 */
export function withContext(mw: RequestHandler): RequestHandler {
  return (req, res, next) => mw(req, res, (err?: unknown) => runWithContext(req.ctx, () => next(err)));
}
