/**
 * A classified vendor error. Delivery retries only `transient` errors, and push tokens are removed
 * when `invalidRecipient` is set (the device token is gone for good). Messages never contain
 * credentials or message bodies.
 */
export class MessagingError extends Error {
  readonly code: string;
  readonly transient: boolean;
  readonly invalidRecipient: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: {
      code: string;
      transient?: boolean;
      invalidRecipient?: boolean;
      status?: number;
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = 'MessagingError';
    this.code = opts.code;
    this.transient = opts.transient ?? false;
    this.invalidRecipient = opts.invalidRecipient ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Unclassified errors (bugs, mock failures) are retried like before vendor classification existed. */
export function isTransientError(err: unknown): boolean {
  return !(err instanceof MessagingError) || err.transient;
}

/** HTTP 429/5xx and timeouts are worth retrying; other 4xx responses are not. */
export const transientStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** `Retry-After` as milliseconds (seconds or an HTTP date), capped at one hour. */
export function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3_600_000) : undefined;
}
