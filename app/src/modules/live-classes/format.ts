import type { LiveSessionStatus } from '@erp/shared';

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short' });
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
