import { getContext } from '../shared/context';
import { config } from './config';
import { logger } from './logger';

type Tags = Record<string, string | number | boolean | null | undefined>;

export interface TrackedError {
  error: unknown;
  level: 'error' | 'fatal';
  /** Non-PII context only: route pattern, job name… (request, institute and user ids are added). */
  tags?: Tags;
}

/**
 * Error tracking adapter (ERROR_TRACKING_PROVIDER). `log` writes a structured `error_tracking`
 * entry for log-based alerting; `webhook` POSTs JSON events to a collector. A vendor SDK (Sentry,
 * Rollbar…) plugs in as another implementation via setErrorTracker().
 */
export interface ErrorTracker {
  readonly name: string;
  capture(event: TrackedError): void;
  /** Waits (bounded) for in-flight reports, e.g. before the process exits. */
  flush(timeoutMs?: number): Promise<void>;
}

export interface ErrorTrackingEvent {
  timestamp: string;
  level: TrackedError['level'];
  environment: string;
  release: string;
  error: { type: string; message: string; stack?: string };
  tags: Tags;
}

export function toEvent(e: TrackedError): ErrorTrackingEvent {
  const ctx = getContext();
  const err = e.error;
  return {
    timestamp: new Date().toISOString(),
    level: e.level,
    environment: config.NODE_ENV,
    release: config.APP_VERSION,
    error:
      err instanceof Error
        ? { type: err.name, message: err.message, stack: err.stack }
        : { type: typeof err, message: String(err) },
    tags: { requestId: ctx.requestId, instituteId: ctx.instituteId, userId: ctx.userId, ...e.tags },
  };
}

const noopTracker: ErrorTracker = { name: 'none', capture: () => undefined, flush: async () => undefined };

const logTracker: ErrorTracker = {
  name: 'log',
  capture: (e) => logger.error({ errorTracking: toEvent(e) }, 'error_tracking'),
  flush: async () => undefined,
};

/** Sends at most `perMinute` events a minute so an outage can't flood the collector. */
export class WebhookErrorTracker implements ErrorTracker {
  readonly name = 'webhook';
  private readonly inFlight = new Set<Promise<void>>();
  private windowStart = 0;
  private sent = 0;
  private dropped = 0;

  constructor(
    private readonly url: string,
    private readonly perMinute = 60,
  ) {}

  capture(e: TrackedError): void {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.sent = 0;
    }
    if (this.sent >= this.perMinute) {
      this.dropped++;
      return;
    }
    this.sent++;
    const event = { ...toEvent(e), droppedSinceLast: this.dropped };
    this.dropped = 0;
    const p: Promise<void> = fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        if (!res.ok) logger.warn({ status: res.status }, 'error tracking webhook rejected an event');
      })
      .catch((err: unknown) => logger.warn({ reason: String(err) }, 'error tracking webhook failed'))
      .finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  async flush(timeoutMs = 3000): Promise<void> {
    if (!this.inFlight.size) return;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }
}

function fromConfig(): ErrorTracker {
  if (config.ERROR_TRACKING_PROVIDER === 'log') return logTracker;
  if (config.ERROR_TRACKING_PROVIDER === 'webhook')
    return new WebhookErrorTracker(config.ERROR_TRACKING_WEBHOOK_URL!);
  return noopTracker;
}

let tracker = fromConfig();

export const getErrorTracker = () => tracker;

/** Swap the adapter (tests, or a vendor SDK wired at startup). */
export function setErrorTracker(next: ErrorTracker | null): void {
  tracker = next ?? fromConfig();
}

/** Never throws: tracking must not break the request or job that failed. */
export function captureError(error: unknown, tags?: Tags, level: TrackedError['level'] = 'error'): void {
  try {
    tracker.capture({ error, level, tags });
  } catch (err) {
    logger.warn({ reason: String(err) }, 'error tracking failed');
  }
}
