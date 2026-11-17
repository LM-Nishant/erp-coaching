/**
 * Small in-process TTL cache for public site responses. Admin writes call `invalidateSite()`;
 * data owned by other modules (courses, batches) refreshes when the TTL expires.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 2000;

const entries = new Map<string, { value: unknown; expires: number }>();

export async function cached<T>(instituteId: number, key: string, load: () => Promise<T>): Promise<T> {
  const k = `${instituteId}:${key}`;
  const hit = entries.get(k);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await load();
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  entries.set(k, { value, expires: Date.now() + TTL_MS });
  return value;
}

export function invalidateSite(instituteId: number) {
  const prefix = `${instituteId}:`;
  for (const k of entries.keys()) if (k.startsWith(prefix)) entries.delete(k);
}

/** Host → institute lookups are cached separately (domain changes invalidate everything). */
export function invalidateAllSites() {
  entries.clear();
}

export const PUBLIC_CACHE_CONTROL = `public, max-age=${TTL_MS / 1000}, stale-while-revalidate=300`;
