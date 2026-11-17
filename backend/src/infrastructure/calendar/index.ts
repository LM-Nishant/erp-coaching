import crypto from 'node:crypto';

/**
 * Calendar + video-meeting provider adapter (parent-teacher appointments, spec §4.16).
 * Implementations: `mock` (generates a meeting link, keeps events in memory) and a Google
 * Calendar/Meet stub. Business modules call `getCalendarProvider()`; never import vendor SDKs.
 */
export interface CalendarEventInput {
  /** Stable reference from the caller, e.g. `appointments:42`. */
  externalRef: string;
  title: string;
  description?: string;
  /** Wall-clock start/end (`YYYY-MM-DDTHH:MM`) in the institute's local time. */
  start: string;
  end: string;
  attendees: { name: string; email?: string | null }[];
  /** Create a video meeting (Google Meet) link for online meetings. */
  withMeeting: boolean;
  location?: string | null;
}

export interface CalendarEventResult {
  eventId: string;
  meetingUrl: string | null;
}

export interface CalendarProvider {
  readonly name: string;
  createEvent(input: CalendarEventInput): Promise<CalendarEventResult>;
  updateEvent(eventId: string, input: CalendarEventInput): Promise<CalendarEventResult>;
  cancelEvent(eventId: string): Promise<void>;
}

const meetCode = () => {
  const s = crypto
    .randomBytes(8)
    .toString('hex')
    .replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]);
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7, 10)}`;
};

export interface MockCalendarEvent extends CalendarEventInput {
  eventId: string;
  meetingUrl: string | null;
  cancelled: boolean;
}

export class MockCalendarProvider implements CalendarProvider {
  readonly name = 'mock';
  /** Inspectable in tests. */
  readonly events = new Map<string, MockCalendarEvent>();

  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    const eventId = `mock_${crypto.randomUUID()}`;
    const meetingUrl = input.withMeeting ? `https://meet.mock.invalid/${meetCode()}` : null;
    this.events.set(eventId, { ...input, eventId, meetingUrl, cancelled: false });
    return { eventId, meetingUrl };
  }

  async updateEvent(eventId: string, input: CalendarEventInput): Promise<CalendarEventResult> {
    const prev = this.events.get(eventId);
    if (!prev) return this.createEvent(input);
    const meetingUrl = input.withMeeting
      ? (prev.meetingUrl ?? `https://meet.mock.invalid/${meetCode()}`)
      : null;
    this.events.set(eventId, { ...input, eventId, meetingUrl, cancelled: false });
    return { eventId, meetingUrl };
  }

  async cancelEvent(eventId: string): Promise<void> {
    const ev = this.events.get(eventId);
    if (ev) ev.cancelled = true;
  }
}

/**
 * Google Calendar + Meet. To implement: per-institute OAuth credentials stored encrypted, then
 * `events.insert` with `conferenceData.createRequest` for Meet links and `events.patch/delete`.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google';
  private fail(): never {
    throw new Error('Google Calendar provider is not configured yet');
  }
  async createEvent(): Promise<CalendarEventResult> {
    return this.fail();
  }
  async updateEvent(): Promise<CalendarEventResult> {
    return this.fail();
  }
  async cancelEvent(): Promise<void> {
    return this.fail();
  }
}

export const mockCalendarProvider = new MockCalendarProvider();

/** Resolve the calendar provider for an institute (institute-level settings later; mock today). */
export function getCalendarProvider(_instituteId: number, name = 'mock'): CalendarProvider {
  if (name === 'mock') return mockCalendarProvider;
  if (name === 'google') return new GoogleCalendarProvider();
  throw new Error(`Calendar provider "${name}" is not implemented`);
}
