import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { MulterError } from 'multer';
import {
  UniqueConstraintError,
  ValidationError as SequelizeValidationError,
  ForeignKeyConstraintError,
} from 'sequelize';
import { AppError } from '../errors';
import { logger, redactUrl } from '../../infrastructure/logger';
import { captureError } from '../../infrastructure/error-tracking';

export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json({ error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let e: AppError;
  if (err instanceof AppError) e = err;
  else if (err instanceof UniqueConstraintError)
    e = new AppError(
      409,
      'DUPLICATE',
      'A record with the same unique value already exists',
      err.errors.map((x) => ({ path: x.path, message: x.message })),
    );
  else if (err instanceof ForeignKeyConstraintError)
    e = new AppError(409, 'FOREIGN_KEY', 'Referenced record does not exist or is still in use');
  else if (err instanceof SequelizeValidationError)
    e = new AppError(
      422,
      'VALIDATION_ERROR',
      'Invalid data',
      err.errors.map((x) => ({ path: x.path, message: x.message })),
    );
  else if (err instanceof MulterError)
    e = new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_ERROR', err.message);
  else if (err?.type === 'entity.parse.failed') e = new AppError(400, 'INVALID_JSON', 'Malformed JSON body');
  else if (err?.type === 'entity.too.large')
    e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  else e = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');

  if (e.status >= 500) {
    const route = routePattern(req);
    logger.error({ err, method: req.method, route, path: redactUrl(req.path) }, 'Unhandled error');
    captureError(err, { method: req.method, route: route ?? 'unmatched', status: e.status });
  }
  if (e.retryAfterSeconds) res.set('Retry-After', String(Math.ceil(e.retryAfterSeconds)));
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
};

/** `/api/files/signed/:token` rather than the URL, so reports never carry tokens or ids. */
function routePattern(req: Request): string | undefined {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : undefined;
}
