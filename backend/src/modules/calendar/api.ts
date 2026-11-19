/**
 * Public cross-module API of the calendar module. Import from here, not from internal files.
 * A module whose records become calendar events registers a source (in its integrations.ts) and
 * calls `syncCalendarEvent` after each committed change. See docs/integrations/google-calendar.md.
 */
export {
  calendarSyncStatus,
  registerCalendarSource,
  syncCalendarEvent,
  type CalendarSource,
  type CalendarSourceEvent,
  type CalendarSyncResult,
} from './sync.service';
