import crypto from 'node:crypto';
import {
  CalendarProviderError,
  type CalendarEventInput,
  type CalendarEventResult,
  type CalendarProvider,
} from './types';

/**
 * Calendar + video-meeting provider adapters (parent-teacher appointments, spec §4.16).
 * `mock` (the default: fake Meet links, events kept in memory) and `google` (Calendar API v3 +
 * Meet, `./google`). Business modules never call providers directly: the calendar module resolves
 * the provider and the connected account (`modules/calendar/api.ts`). Never import vendor SDKs.
 */
export * from './types';
export {
  checkGoogleClient,
  exchangeGoogleCode,
  GoogleCalendarProvider,
  googleAuthUrl,
  GOOGLE_EVENTS_SCOPE,
  GOOGLE_SCOPES,
  googleEventId,
  googleIdentity,
  refreshGoogleToken,
  revokeGoogleToken,
  type GoogleCalendarProviderOptions,
  type GoogleOAuthClient,
  type GoogleTokens,
} from './google';

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
    // Like Google: a deleted event cannot be updated (the caller creates a new one).
    if (prev.cancelled) throw new CalendarProviderError('not_found', 'The mock event was cancelled', 410);
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

export const mockCalendarProvider = new MockCalendarProvider();
