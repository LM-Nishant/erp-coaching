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

const SAFE_REQUEST_ID = /^[\w.:-]{1,64}$/;

/** Reuses a well-formed `X-Request-Id` from the proxy/client, otherwise generates one. */
export function resolveRequestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && SAFE_REQUEST_ID.test(header) ? header : crypto.randomUUID();
}

/** Creates the per-request context (AsyncLocalStorage). Must run after body parsers. */
export const contextMiddleware: RequestHandler = (req, res, next) => {
  const ctx: RequestContext = {
    // pino-http (when enabled) already assigned the id, so access logs and app logs correlate.
    requestId: typeof req.id === 'string' ? req.id : resolveRequestId(req.headers['x-request-id']),
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
