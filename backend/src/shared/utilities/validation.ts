import type { z } from 'zod';
import { AppError } from '../errors';

/** Parse untrusted input with a zod schema; throws 422 VALIDATION_ERROR. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'Invalid request',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
