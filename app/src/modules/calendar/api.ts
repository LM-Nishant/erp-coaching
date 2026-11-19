import { Capacitor } from '@capacitor/core';
import type {
  CalendarConnectClient,
  CalendarConnectionDto,
  CalendarConnectResult,
  CalendarConnectStartDto,
  CalendarPlatformStatusDto,
  CalendarSettingsDto,
  CalendarSyncDto,
  CalendarTestResultDto,
  MyCalendarDto,
} from '@erp/shared';
import { CALENDAR_CONNECT_RESULTS } from '@erp/shared';
import { api } from '@/core/api';

const client = (): CalendarConnectClient => (Capacitor.isNativePlatform() ? 'native' : 'web');

export const calendarApi = {
  mine: () => api.get<MyCalendarDto>('/calendar/me'),
  connectMine: () => api.post<CalendarConnectStartDto>('/calendar/me/connect', { client: client() }),
  testMine: () => api.post<CalendarTestResultDto>('/calendar/me/test'),
  disconnectMine: () => api.delete('/calendar/me'),

  settings: () => api.get<CalendarSettingsDto>('/calendar/settings'),
  connectOrganiser: () =>
    api.post<CalendarConnectStartDto>('/calendar/organiser/connect', { client: client() }),
  test: (id: number) => api.post<CalendarTestResultDto>(`/calendar/connections/${id}/test`),
  disconnect: (id: number) => api.delete(`/calendar/connections/${id}`),

  platform: () => api.get<CalendarPlatformStatusDto>('/admin/calendar'),
  testPlatform: () => api.post<CalendarTestResultDto>('/admin/calendar/test'),
};

/**
 * Opens Google's consent screen: in this tab on the web (Google sends the browser back to the app),
 * and in the system browser in the mobile app, because Google refuses sign-in inside app web views.
 * The app reloads the connection when the user returns to it.
 */
export function openConsent(start: CalendarConnectStartDto): void {
  if (Capacitor.isNativePlatform()) window.open(start.startUrl, '_blank');
  else window.location.assign(start.startUrl);
}

type Tone = 'success' | 'warning' | 'danger';

const RESULT_MESSAGES: Record<CalendarConnectResult, [string, Tone]> = {
  connected: ['Google Calendar connected', 'success'],
  denied: ['Google Calendar was not connected: access was declined', 'warning'],
  missing_scope: ['Allow access to your calendar events to connect Google Calendar', 'warning'],
  expired: ['The connection link expired. Please try again.', 'warning'],
  error: ['Google Calendar could not be connected. Please try again.', 'danger'],
};

/** Toast for the `?calendar=<result>` the consent flow returns to the web app with. */
export function connectResultMessage(value: unknown): [string, Tone] | null {
  return (CALENDAR_CONNECT_RESULTS as readonly unknown[]).includes(value)
    ? RESULT_MESSAGES[value as CalendarConnectResult]
    : null;
}

export const connectionLabel = (c: CalendarConnectionDto) =>
  c.status === 'active' ? `Connected as ${c.accountEmail ?? 'a Google account'}` : 'Needs reconnecting';

/** Where a meeting stands in Google Calendar; null in test (mock) mode. */
export function syncLabel(
  s: CalendarSyncDto | null | undefined,
): { title: string; detail: string | null } | null {
  if (!s || s.provider === 'mock') return null;
  switch (s.status) {
    case 'synced':
      return { title: 'In Google Calendar', detail: null };
    case 'pending':
      return { title: 'Updating Google Calendar…', detail: s.error ? `Retrying: ${s.error}` : null };
    case 'deleted':
      return { title: 'Removed from Google Calendar', detail: null };
    default:
      return { title: 'Not in Google Calendar', detail: s.error };
  }
}
