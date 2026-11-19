export class AppError extends Error {
  /** Sent as the `Retry-After` header. */
  retryAfterSeconds?: number;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const BadRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const Unauthorized = (message = 'Authentication required', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const Forbidden = (
  message = 'You do not have permission to perform this action',
  code = 'FORBIDDEN',
) => new AppError(403, code, message);
export const NotFound = (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`);
export const Conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new AppError(409, code, message, details);
export const TooManyRequests = (message: string, code = 'RATE_LIMITED') => new AppError(429, code, message);
export const LimitExceeded = (message: string, details?: unknown) =>
  new AppError(402, 'PLAN_LIMIT_EXCEEDED', message, details);
