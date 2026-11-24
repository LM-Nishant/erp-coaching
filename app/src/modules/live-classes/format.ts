import type { LiveSessionDto, LiveSessionStatus } from '@erp/shared';
import { formatDateTime, formatTime } from '@/core/format';

export const when = (iso: string) => formatDateTime(iso);
export const time = (iso: string) => formatTime(iso);

/** Students see "Starting soon" (and the reminder push arrives) this long before a class. */
export const SOON_MINUTES = 10;

/** The class a student should see first: one that is live, else the next scheduled one not yet over. */
export function nextClass(list: readonly LiveSessionDto[], now = Date.now()): LiveSessionDto | null {
  const live = list.find((s) => s.status === 'live');
  if (live) return live;
  return (
    list
      .filter((s) => s.status === 'scheduled' && Date.parse(s.scheduledEndAt) > now)
      .sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt))[0] ?? null
  );
}

export type JoinState =
  | { kind: 'live' }
  | { kind: 'soon'; minutes: number }
  | { kind: 'later'; minutes: number }
  | { kind: 'waiting' }
  | { kind: 'over' };

/**
 * What the Join button says: `live` → join now; `soon` → within SOON_MINUTES of the start;
 * `waiting` → start time passed but the teacher has not started yet; `later`; `over` (ended/cancelled).
 */
export function joinState(
  s: Pick<LiveSessionDto, 'status' | 'scheduledStartAt'>,
  now = Date.now(),
): JoinState {
  if (s.status === 'live') return { kind: 'live' };
  if (s.status !== 'scheduled') return { kind: 'over' };
  const minutes = Math.ceil((Date.parse(s.scheduledStartAt) - now) / 60_000);
  if (minutes <= 0) return { kind: 'waiting' };
  return minutes <= SOON_MINUTES ? { kind: 'soon', minutes } : { kind: 'later', minutes };
}
export const duration = (seconds: number | null) => {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
};
export const size = (bytes: number) =>
  bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
export const statusColor = (s: LiveSessionStatus) =>
  ({ live: 'danger', scheduled: 'primary', ended: 'medium', cancelled: 'warning' })[s];
