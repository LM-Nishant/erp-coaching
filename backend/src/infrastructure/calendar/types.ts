export interface CalendarEventInput {
  /** Stable reference from the caller, e.g. `appointments:42`. */
  externalRef: string;
  /**
   * Idempotency key for this event version. Providers derive their event id from it, so a create
   * that is retried after a timeout finds the event it already made instead of duplicating it.
   */
  requestId?: string;
  title: string;
  description?: string;
  /** Wall-clock start/end (`YYYY-MM-DDTHH:MM`) in the institute's local time. */
  start: string;
  end: string;
  /** IANA zone of `start`/`end` (the institute's). Providers that need instants convert with it. */
  timeZone?: string;
  attendees: { name: string; email?: string | null }[];
  /** Create a video meeting (Google Meet) link for online meetings. */
  withMeeting: boolean;
  location?: string | null;
}

export interface CalendarEventResult {
  eventId: string;
  meetingUrl: string | null;
  /** The provider is still creating the meeting; read the event again shortly for its link. */
  conferencePending?: boolean;
}

export interface CalendarProvider {
  readonly name: string;
  createEvent(input: CalendarEventInput): Promise<CalendarEventResult>;
  updateEvent(eventId: string, input: CalendarEventInput): Promise<CalendarEventResult>;
  cancelEvent(eventId: string): Promise<void>;
}

/**
 * `auth`: the account's grant is gone or lacks access (reconnect needed, don't retry).
 * `retryable`: rate limits, quota, 5xx, timeouts. `not_found`: the event no longer exists.
 * `invalid`: the provider rejected the request.
 */
export type CalendarErrorKind = 'auth' | 'retryable' | 'not_found' | 'invalid';

/** Provider failure. Messages never contain tokens or authorization codes. */
export class CalendarProviderError extends Error {
  constructor(
    readonly kind: CalendarErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CalendarProviderError';
  }
}
