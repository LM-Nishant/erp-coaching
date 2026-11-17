import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { lmsApi } from './api';

/**
 * Encrypted offline lectures (mobile app only).
 *
 * - Files live in the app-private data directory (`Directory.Data`), never in shared storage, and the app offers no
 *   share/export action.
 * - Every 4 MB block is encrypted with AES-256-GCM using the per-licence key issued by the server, so copying the
 *   files off a rooted device yields ciphertext only.
 * - Each copy carries the licence expiry; expired or server-revoked copies are deleted on every sync and are never
 *   played. The web build never downloads videos.
 */

const ROOT = 'lms-offline';
const INDEX = `${ROOT}/index.json`;
const BLOCK = 4 * 1024 * 1024;

export interface OfflineItem {
  licenseId: number;
  resourceId: number;
  title: string;
  mimeType: string;
  sizeBytes: number;
  blocks: number;
  expiresAt: string;
  watermark: string;
  savedAt: string;
  /** Base64 AES key, kept only inside the app sandbox. */
  key: string;
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

async function readIndex(): Promise<OfflineItem[]> {
  try {
    const { data } = await Filesystem.readFile({
      path: INDEX,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return JSON.parse(data as string) as OfflineItem[];
  } catch {
    return [];
  }
}
const writeIndex = (items: OfflineItem[]) =>
  Filesystem.writeFile({
    path: INDEX,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    data: JSON.stringify(items),
    recursive: true,
  });

async function removeFiles(licenseId: number) {
  await Filesystem.rmdir({ path: `${ROOT}/${licenseId}`, directory: Directory.Data, recursive: true }).catch(
    () => undefined,
  );
}

const isExpired = (i: OfflineItem) => new Date(i.expiresAt).getTime() <= Date.now();

/** Valid copies only; expired ones are purged locally even when the device is offline. */
export async function listOffline(): Promise<OfflineItem[]> {
  if (!offlineSupported()) return [];
  const items = await readIndex();
  const keep = items.filter((i) => !isExpired(i));
  if (keep.length !== items.length) {
    for (const i of items.filter(isExpired)) await removeFiles(i.licenseId);
    await writeIndex(keep);
  }
  return keep;
}

/** Reconciles with the server: revoked licences (access lost, unpublished…) are deleted from the device. */
export async function syncOffline() {
  if (!offlineSupported()) return;
  const server = await lmsApi.offlineLicenses();
  const valid = new Map(server.filter((l) => l.contentKey && !l.revokedAt).map((l) => [l.id, l]));
  const items = await readIndex();
  const keep: OfflineItem[] = [];
  for (const i of items) {
    const s = valid.get(i.licenseId);
    if (!s || isExpired(i)) await removeFiles(i.licenseId);
    else keep.push({ ...i, expiresAt: s.expiresAt });
  }
  await writeIndex(keep);
}

export async function isSavedOffline(resourceId: number) {
  return (await listOffline()).some((i) => i.resourceId === resourceId);
}

/** Downloads a lecture into the sandbox, encrypting each block before it touches the disk. */
export async function saveOffline(resourceId: number, onProgress: (done: number, total: number) => void) {
  if (!offlineSupported()) throw new Error('Offline downloads are available in the mobile app only');
  const lic = await lmsApi.offlineLicense(resourceId);
  const key = await importKey(lic.contentKey);
  const res = await fetch(lic.downloadUrl);
  if (!res.ok || !res.body) throw new Error('Download failed');
  const reader = res.body.getReader();
  let buffer = new Uint8Array(0);
  let block = 0;
  let done = 0;
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
    throw e;
  }
  const items = (await readIndex()).filter((i) => i.resourceId !== resourceId);
  for (const old of (await readIndex()).filter((i) => i.resourceId === resourceId))
    await removeFiles(old.licenseId);
  items.push({
    licenseId: lic.id,
    resourceId,
    title: lic.title,
    mimeType: lic.mimeType,
    sizeBytes: lic.sizeBytes,
    blocks: block,
    expiresAt: lic.expiresAt,
    watermark: lic.watermark.text,
    savedAt: new Date().toISOString(),
    key: lic.contentKey,
  });
  await writeIndex(items);
}

export async function removeOffline(item: OfflineItem) {
  await removeFiles(item.licenseId);
  await writeIndex((await readIndex()).filter((i) => i.licenseId !== item.licenseId));
  await lmsApi.revokeOffline(item.licenseId).catch(() => undefined);
}

/** Decrypts an offline copy into an in-memory object URL (revoke it when the player closes). */
export async function openOffline(resourceId: number): Promise<{ url: string; item: OfflineItem }> {
  const item = (await listOffline()).find((i) => i.resourceId === resourceId);
  if (!item) throw new Error('This lecture is not saved offline or its offline access has expired');
  const key = await importKey(item.key);
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
