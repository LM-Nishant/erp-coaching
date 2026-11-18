import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { AuthTokens, MeDto } from '@erp/shared';
import { SecureKey, secureGet, secureGetJson, secureRemove, secureSet, secureSetJson } from './secure-storage';

/**
 * Session persisted on the device: secure storage in the mobile app (iOS Keychain / Android Keystore), localStorage on
 * the web (see core/secure-storage.ts).
 */
export interface StoredSession {
  accessToken: string;
  refreshToken: string | null;
  branchId?: number | null;
  /** Signed-in user (the super admin while impersonating). Tags offline content and the biometric credential. */
  userId?: number | null;
  /** Original super-admin session while impersonating. */
  impersonator?: { accessToken: string; refreshToken: string | null } | null;
}

/** Key used by app versions that kept the session in plain preferences. */
const LEGACY_KEY = 'erp.session';

let cache: StoredSession | null | undefined;
let loading: Promise<StoredSession | null> | null = null;
let writes: Promise<unknown> = Promise.resolve();

async function read(): Promise<StoredSession | null> {
  let raw = await secureGet(SecureKey.session);
  if (!raw && Capacitor.isNativePlatform()) {
    const legacy = (await Preferences.get({ key: LEGACY_KEY })).value;
    if (legacy) {
      await secureSet(SecureKey.session, legacy);
      await Preferences.remove({ key: LEGACY_KEY });
      raw = legacy;
    }
  }
  try {
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function loadSession(): Promise<StoredSession | null> {
  if (cache !== undefined) return Promise.resolve(cache);
  loading ??= read()
    .then((s) => {
      if (cache === undefined) cache = s;
      return cache;
    })
    .finally(() => (loading = null));
  return loading;
}

/** Writes are queued so the stored value always matches the last call (e.g. a refresh racing a sign-out). */
function persist(task: () => Promise<unknown>) {
  writes = writes.catch(() => undefined).then(task);
  return writes;
}

export async function saveSession(session: StoredSession | null) {
  cache = session;
  await persist(() =>
    session ? secureSet(SecureKey.session, JSON.stringify(session)) : secureRemove(SecureKey.session),
  );
}

/**
 * Updates the stored session if there still is one and `matches` it. Never brings back a session that was signed out
 * (or replaced) while the caller was waiting, e.g. on a token refresh. Returns whether it was updated.
 */
export async function patchSession(
  patch: Partial<StoredSession>,
  matches: (current: StoredSession) => boolean = () => true,
): Promise<boolean> {
  await loadSession();
  if (!cache || !matches(cache)) return false;
  await saveSession({ ...cache, ...patch });
  return true;
}

/** Stores refreshed tokens, unless the session was signed out or replaced during the refresh. */
export const updateTokens = (
  tokens: Pick<AuthTokens, 'accessToken'> & { refreshToken?: string | null },
  usedRefreshToken: string,
) =>
  patchSession(
    { accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) },
    (s) => s.refreshToken === usedRefreshToken,
  );

/**
 * Last `/auth/me` response: lets the app start offline (offline lectures) and show who is signed in on the lock screen.
 * A profile is written only while there is a session, so a response arriving after sign-out cannot restore it.
 */
export const loadProfile = () => secureGetJson<MeDto>(SecureKey.profile);

export const saveProfile = (me: MeDto | null) =>
  persist(async () => {
    if (!me) return secureRemove(SecureKey.profile);
    if (cache) await secureSetJson(SecureKey.profile, me);
  });
