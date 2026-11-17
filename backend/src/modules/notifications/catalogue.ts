import { NOTIFICATION_EVENTS, type NotificationEventDef } from '@erp/shared';
import { BadRequest } from '../../shared/errors';

const events = new Map<string, NotificationEventDef>(NOTIFICATION_EVENTS.map((e) => [e.key, e]));

/**
 * Adds module-specific events to the catalogue (call at import time or in `models()` of your module).
 * Re-registering a key replaces it, so a module can refine the default template of its own events.
 */
export function registerNotificationEvents(defs: NotificationEventDef[]): void {
  for (const d of defs) {
    if (!/^[a-z0-9-]+\.[a-z0-9-.]+$/.test(d.key)) throw new Error(`Invalid notification event key ${d.key}`);
    events.set(d.key, d);
  }
}

export function listEvents(): NotificationEventDef[] {
  return [...events.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key),
  );
}

export function findEvent(key: string): NotificationEventDef | undefined {
  return events.get(key);
}

export function getEvent(key: string): NotificationEventDef {
  const e = events.get(key);
  if (!e) throw BadRequest(`Unknown notification event "${key}"`);
  return e;
}
