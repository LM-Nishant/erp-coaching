import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { sessionEndSettled } from '@/core/api';
import { SecureKey, secureGetJson, secureSetJson } from '@/core/secure-storage';
import { useAuthStore } from '@/stores/auth';
import { lmsApi } from './api';

/**
 * Encrypted offline lectures (mobile app only, spec 4.18).
 *
 * - Files live in the app-private data directory (`Directory.Data`), never in shared storage, and the app offers no
 *   share/export action.
 * - Every 4 MB block is encrypted with AES-256-GCM using the per-licence key issued by the server. The keys are kept in
 *   secure storage (Keychain / Android Keystore), apart from the files, so copying the files off a device yields
 *   ciphertext only.
 * - A copy belongs to the user and institute that saved it: other accounts signed in on the same device neither see nor
 *   delete it.
 * - Each copy carries its licence expiry (licence hours, capped by the learner's access). Expired copies are deleted
 *   and never played.
 * - When online, a copy is checked with the server before it plays (server time, so the device clock does not matter).
 *   Licences the server revoked (access ended, lecture unpublished or no longer offline-enabled, device revoked) delete
 *   the copy. A revoked device or deactivated account also wipes the user's copies as soon as the app hears of it
 *   (`wipeOffline`, run from core/session.ts).
 * - Offline, expiry relies on the device clock. If the clock reads earlier than a time the app has already seen,
 *   copies do not open until a check with the server succeeds; that check also replaces the time seen.
 * - The web build never downloads videos.
 */

const ROOT = 'lms-offline';
const INDEX = `${ROOT}/index.json`;
const BLOCK = 4 * 1024 * 1024;
const SYNC_WAIT_MS = 5000;
/** Clock corrections smaller than this are not treated as the clock being set back. */
const CLOCK_SLACK_MS = 10 * 60_000;

export interface OfflineItem {
  licenseId: number;
  resourceId: number;
  /** Owner. `null`: saved before copies had owners; adopted by the next account that opens the store. */
  userId: number | null;
  instituteId: number | null;
  title: string;
  mimeType: string;
  sizeBytes: number;
  blocks: number;
  expiresAt: string;
  watermark: string;
  savedAt: string;
}

/** Index rows written by older app versions also carry the key. */
type IndexRow = Omit<OfflineItem, 'userId' | 'instituteId'> &
  Partial<Pick<OfflineItem, 'userId' | 'instituteId'>> & { key?: string };

interface KeyRing {
  /** Base64 AES key per licence id. */
  keys: Record<string, string>;
  /** Latest device clock reading seen (ms, updated at most once a minute). */
  seenAt: number;
}

interface Store {
  items: OfflineItem[];
  ring: KeyRing;
  /** The device clock reads earlier than a time already seen: offline expiry cannot be trusted. */
  clockSetBack: boolean;
}

export const offlineSupported = () => Capacitor.isNativePlatform();

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const importKey = (b64: string) =>
  crypto.subtle.importKey('raw', b64ToBytes(b64), 'AES-GCM', false, ['encrypt', 'decrypt']);

function owner() {
  const me = useAuthStore().me;
  return me?.institute ? { userId: me.user.id, instituteId: me.institute.id } : null;
}
type Owner = NonNullable<ReturnType<typeof owner>>;
const owns = (o: Owner | null, i: OfflineItem) =>
  !!o && i.userId === o.userId && i.instituteId === o.instituteId;

let queue: Promise<unknown> = Promise.resolve();
/** Index and key updates run one at a time: a sync can overlap a download or a wipe. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<IndexRow[]> {
  try {
    const { data } = await Filesystem.readFile({
      path: INDEX,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return JSON.parse(data as string) as IndexRow[];
  } catch {
    return [];
  }
}

async function removeFiles(licenseId: number) {
  await Filesystem.rmdir({ path: `${ROOT}/${licenseId}`, directory: Directory.Data, recursive: true }).catch(
    () => undefined,
  );
}

async function save(s: Store) {
  await secureSetJson(SecureKey.offlineKeys, s.ring);
  await Filesystem.writeFile({
    path: INDEX,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    data: JSON.stringify(s.items),
    recursive: true,
  });
}

/** Deletes copies (files and keys) matching `drop`; returns whether any was deleted. */
async function purge(s: Store, drop: (i: OfflineItem) => boolean) {
  const gone = s.items.filter(drop);
  for (const i of gone) {
    await removeFiles(i.licenseId);
    delete s.ring.keys[i.licenseId];
  }
  s.items = s.items.filter((i) => !gone.includes(i));
  return gone.length > 0;
}

const isExpired = (i: OfflineItem, now: number) => new Date(i.expiresAt).getTime() <= now;

/**
 * Loads the index and key ring, migrating copies saved by older versions (key moved to secure storage, adopted by the
 * signed-in account), and deletes expired copies of every account.
 */
async function load(): Promise<Store> {
  const rows = await readIndex();
  const ring = (await secureGetJson<KeyRing>(SecureKey.offlineKeys)) ?? { keys: {}, seenAt: 0 };
  const now = Date.now();
  const clockSetBack = now < ring.seenAt - CLOCK_SLACK_MS;
  let dirty = now - ring.seenAt > 60_000;
  if (dirty) ring.seenAt = now;
  const me = owner();
  const items = rows.map(({ key, ...row }): OfflineItem => {
    if (key) {
      ring.keys[row.licenseId] ??= key;
      dirty = true;
    }
    if (row.userId == null && me) {
      dirty = true;
      return { ...row, ...me };
    }
    return { ...row, userId: row.userId ?? null, instituteId: row.instituteId ?? null };
  });
  const s: Store = { items, ring, clockSetBack };
  if ((await purge(s, (i) => isExpired(i, now))) || dirty) await save(s);
  return s;
}

/** The signed-in account's valid copies. */
export async function listOffline(): Promise<OfflineItem[]> {
  if (!offlineSupported()) return [];
  const me = owner();
  return exclusive(async () => (await load()).items.filter((i) => owns(me, i)));
}

/** Reconciles the signed-in account's copies with the server: copies whose licence is no longer valid are deleted. */
export async function syncOffline() {
  if (!offlineSupported()) return;
  const me = owner();
  if (!me) return;
  const server = await lmsApi.offlineLicenses();
  const valid = new Map(server.filter((l) => l.contentKey && !l.revokedAt).map((l) => [l.id, l]));
  await exclusive(async () => {
    const s = await load();
    // Checked with the server: earlier clock readings no longer count (e.g. a clock that ran ahead and was put right).
    s.ring.seenAt = Date.now();
    await purge(s, (i) => owns(me, i) && !valid.has(i.licenseId));
    for (const i of s.items) {
      const lic = owns(me, i) ? valid.get(i.licenseId) : undefined;
      if (!lic) continue;
      i.expiresAt = lic.expiresAt;
      // e.g. the Keystore entry was lost: the server hands the key out again while the licence is valid
      s.ring.keys[i.licenseId] ??= lic.contentKey!;
    }
    await purge(s, (i) => isExpired(i, Date.now()));
    await save(s);
  });
}

export async function isSavedOffline(resourceId: number) {
  return (await listOffline()).some((i) => i.resourceId === resourceId);
}

/** Downloads a lecture into the sandbox, encrypting each block before it touches the disk. */
export async function saveOffline(resourceId: number, onProgress: (done: number, total: number) => void) {
  if (!offlineSupported()) throw new Error('Offline downloads are available in the mobile app only');
  const me = owner();
  if (!me) throw new Error('Sign in to save lectures offline');
  const lic = await lmsApi.offlineLicense(resourceId);
  const key = await importKey(lic.contentKey);
  let block = 0;
  const flush = async (bytes: Uint8Array) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(bytes)),
    );
    const out = new Uint8Array(iv.length + enc.length);
    out.set(iv);
    out.set(enc, iv.length);
    await Filesystem.writeFile({
      path: `${ROOT}/${lic.id}/${block++}.bin`,
      directory: Directory.Data,
      data: bytesToB64(out),
      recursive: true,
    });
  };
  try {
    const res = await fetch(lic.downloadUrl);
    if (!res.ok || !res.body) throw new Error('Download failed');
    const reader = res.body.getReader();
    let buffer = new Uint8Array(0);
    let done = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) {
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer);
        merged.set(value, buffer.length);
        buffer = merged;
        done += value.length;
        while (buffer.length >= BLOCK) {
          await flush(buffer.subarray(0, BLOCK));
          buffer = buffer.slice(BLOCK);
        }
        onProgress(done, lic.sizeBytes);
      }
      if (end) break;
    }
    if (buffer.length) await flush(buffer);
  } catch (e) {
    await removeFiles(lic.id);
    // free the licence: it counts towards the learner's offline limit until it expires
    await lmsApi.revokeOffline(lic.id).catch(() => undefined);
    throw e;
  }
  await exclusive(async () => {
    const s = await load();
    // the server revoked the previous licence of this lecture when it issued this one
    await purge(s, (i) => owns(me, i) && i.resourceId === resourceId);
    s.items.push({
      licenseId: lic.id,
      resourceId,
      ...me,
      title: lic.title,
      mimeType: lic.mimeType,
      sizeBytes: lic.sizeBytes,
      blocks: block,
      expiresAt: lic.expiresAt,
      watermark: lic.watermark.text,
      savedAt: new Date().toISOString(),
    });
    s.ring.keys[lic.id] = lic.contentKey;
    await save(s);
  });
}

export async function removeOffline(item: OfflineItem) {
  await exclusive(async () => {
    const s = await load();
    await purge(s, (i) => i.licenseId === item.licenseId);
    await save(s);
  });
  await lmsApi.revokeOffline(item.licenseId).catch(() => undefined);
}

/**
 * Deletes a user's copies in every institute (`null`: every copy on the device). Run when the user's access ends on this
 * device: device revoked or account deactivated. Copies not yet adopted by an account (older app versions) go too.
 */
export async function wipeOffline(userId: number | null) {
  if (!offlineSupported()) return;
  await exclusive(async () => {
    const s = await load();
    await purge(s, (i) => userId === null || i.userId === userId || i.userId === null);
    await save(s);
  });
}

/**
 * Decrypts a copy into an in-memory object URL (revoke it when the player closes). When online the licence is checked
 * with the server first, so a copy whose access ended is not played.
 */
export async function openOffline(resourceId: number): Promise<{ url: string; item: OfflineItem }> {
  let checked = false;
  if (navigator.onLine && !useAuthStore().offline) {
    // Bounded: a captive portal or a very slow network must not keep a downloaded lecture from playing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    checked = await Promise.race([
      syncOffline().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), SYNC_WAIT_MS))),
    ]);
    clearTimeout(timer);
    // The sync may have found the device revoked: its copies are wiped before anything is played.
    await sessionEndSettled();
  }
  const me = owner();
  const found = await exclusive(async () => {
    const s = await load();
    if (s.clockSetBack && !checked)
      throw new Error(
        "Your device's clock has been set back. Connect to the internet to watch offline lectures",
      );
    const item = s.items.find((i) => owns(me, i) && i.resourceId === resourceId);
    return item && { item, key: s.ring.keys[item.licenseId] };
  });
  if (!found) throw new Error('This lecture is not saved offline or its offline access has expired');
  if (!found.key)
    throw new Error('This offline copy can no longer be opened. Connect to the internet and save it again');
  const { item } = found;
  const key = await importKey(found.key);
  const parts: ArrayBuffer[] = [];
  for (let n = 0; n < item.blocks; n++) {
    const { data } = await Filesystem.readFile({
      path: `${ROOT}/${item.licenseId}/${n}.bin`,
      directory: Directory.Data,
    });
    const bytes = typeof data === 'string' ? b64ToBytes(data) : new Uint8Array(await data.arrayBuffer());
    parts.push(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)),
    );
  }
  return { url: URL.createObjectURL(new Blob(parts, { type: item.mimeType })), item };
}
