import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MulterError } from 'multer';
import {
  UniqueConstraintError,
  ValidationError as SequelizeValidationError,
  ForeignKeyConstraintError,
} from 'sequelize';
import { AppError } from '../errors';
import { logger } from '../../infrastructure/logger';

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

  if (e.status >= 500) logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
};
