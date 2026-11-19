/** Calendar sync (Google Calendar + Meet) for appointments. See docs/integrations/google-calendar.md. */

export const CALENDAR_PROVIDERS = ['mock', 'google'] as const;
export type CalendarProviderName = (typeof CALENDAR_PROVIDERS)[number];

/** `needs_reconnect`: Google revoked or expired the grant; the owner must connect again. */
export type CalendarConnectionStatus = 'active' | 'needs_reconnect';
export type CalendarSyncStatus = 'pending' | 'synced' | 'failed' | 'deleted';
/** `native`: the consent screen opens in the system browser and ends on a "return to the app" page. */
export type CalendarConnectClient = 'web' | 'native';

/** Outcome of the consent flow, passed back to the web app as `?calendar=<result>`. */
export const CALENDAR_CONNECT_RESULTS = ['connected', 'denied', 'missing_scope', 'expired', 'error'] as const;
export type CalendarConnectResult = (typeof CALENDAR_CONNECT_RESULTS)[number];

export interface CalendarConnectionDto {
  id: number;
  /** null = the institute's organiser calendar. */
  userId: number | null;
  userName: string | null;
  provider: 'google';
  accountEmail: string | null;
  status: CalendarConnectionStatus;
  lastError: string | null;
  connectedAt: string;
  connectedBy: { id: number; name: string } | null;
  lastCheckedAt: string | null;
}

/** Upcoming records by where they stand in Google Calendar. */
export interface CalendarSyncCountsDto {
  synced: number;
  /** Waiting for a retry. */
  pending: number;
  /** Not in Google Calendar: the sync failed, or never ran (confirmed before Google Calendar was on). */
  failed: number;
}

/** Institute settings: the organiser calendar and every teacher's own connection. */
export interface CalendarSettingsDto {
  provider: CalendarProviderName;
  /** The platform has a Google OAuth client, so accounts can be connected. */
  configured: boolean;
  organiser: CalendarConnectionDto | null;
  teachers: CalendarConnectionDto[];
  sync: CalendarSyncCountsDto;
}

/** A teacher's own connection. Without one, events go to the institute's organiser calendar. */
export interface MyCalendarDto {
  provider: CalendarProviderName;
  configured: boolean;
  connection: CalendarConnectionDto | null;
  organiserConnected: boolean;
}

export interface CalendarConnectStartDto {
  /** Open in a top-level browser window (the system browser in the mobile app). */
  startUrl: string;
  expiresAt: string;
}

export interface CalendarTestResultDto {
  ok: boolean;
  message: string;
  calendar?: string | null;
  timeZone?: string | null;
}

/** Super admin view of the platform's Google OAuth client. */
export interface CalendarPlatformStatusDto {
  provider: CalendarProviderName;
  configured: boolean;
  /** Not a secret: it appears in every consent URL. */
  clientId: string | null;
  /** Register this exact URI under "Authorised redirect URIs" in Google Cloud. */
  redirectUri: string;
  scopes: string[];
  connections: { active: number; needsReconnect: number };
}

/** Calendar state of one appointment, for its teacher and appointment managers. */
export interface CalendarSyncDto {
  provider: string;
  status: CalendarSyncStatus;
  error: string | null;
  syncedAt: string | null;
}
