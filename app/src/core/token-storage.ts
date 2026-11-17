import { Preferences } from '@capacitor/preferences';
import type { AuthTokens } from '@erp/shared';

/** Session persisted on the device (Capacitor Preferences → localStorage on web, native storage on iOS/Android). */
export interface StoredSession {
  accessToken: string;
  refreshToken: string | null;
  branchId?: number | null;
  /** Original super-admin session while impersonating. */
  impersonator?: { accessToken: string; refreshToken: string | null } | null;
}

const KEY = 'erp.session';
let cache: StoredSession | null | undefined;

export async function loadSession(): Promise<StoredSession | null> {
  if (cache !== undefined) return cache;
  const { value } = await Preferences.get({ key: KEY });
  cache = value ? (JSON.parse(value) as StoredSession) : null;
  return cache;
}

export async function saveSession(session: StoredSession | null) {
  cache = session;
  if (session) await Preferences.set({ key: KEY, value: JSON.stringify(session) });
  else await Preferences.remove({ key: KEY });
}

export async function updateTokens(
  tokens: Pick<AuthTokens, 'accessToken'> & { refreshToken?: string | null },
) {
  const current = (await loadSession()) ?? { accessToken: '', refreshToken: null };
  await saveSession({
    ...current,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? current.refreshToken,
  });
}
