import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * The one way the app saves or opens files, on the web and in the Android and iOS apps. `downloads.guard.test.ts`
 * fails on download code anywhere else.
 *
 * A Capacitor WebView ignores `<a download>` and blob URLs. Public storage needs permissions on older Android versions,
 * and iOS hides the app's Documents folder from the Files app. So on a device:
 * - `saveFile` writes the file to the app's cache and opens the system share sheet. From there the user opens it,
 *   saves it (Files, Drive, Downloads) or sends it. No storage permission is needed: the app's FileProvider
 *   (res/xml/file_paths.xml) already covers the cache.
 * - `openFileLink` hands a signed link to the system browser (Safari or Chrome), which shows a PDF or saves the file
 *   to Downloads.
 */

/** `cancelled`: the user closed the share sheet, which is not an error. */
export type SaveResult = 'downloaded' | 'shared' | 'cancelled';

const SHARE_FOLDER = 'downloads';
/** Shared copies are kept for a day: long enough for the app that received one to read it. */
const KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_STEM = 80;

/**
 * Saves a file the app already holds, such as an `api.download()` response or a generated CSV: a browser download on
 * the web, the share sheet on a device. `type` applies when `data` is text.
 */
export async function saveFile(
  data: Blob | string,
  fileName: string,
  type = 'application/octet-stream',
): Promise<SaveResult> {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  if (!Capacitor.isNativePlatform()) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    return 'downloaded';
  }
  await pruneSharedCopies();
  const name = safeFileName(fileName);
  const { uri } = await Filesystem.writeFile({
    path: `${SHARE_FOLDER}/${name}`,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  });
  try {
    await Share.share({ title: name, files: [uri], dialogTitle: name });
    return 'shared';
  } catch (e) {
    // Both platforms reject with "Share canceled". Android also does when a target closes without reporting a result.
    if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return 'cancelled';
    throw e;
  }
}

/**
 * Opens a short-lived signed file link (receipts, invoices, payslips, data exports, attachments): a new tab on the
 * web, the system browser on a device.
 */
export function openFileLink(url: string): void {
  if (Capacitor.isNativePlatform()) {
    // Capacitor cancels a top-level navigation away from the app's own host and opens the URL in the system browser,
    // so the app stays where it is. This needs the API host to stay out of `server.allowNavigation`
    // (capacitor.config.ts). `window.open` is not used: iOS blocks it after an await.
    window.location.assign(url);
    return;
  }
  const tab = window.open(url, '_blank');
  if (!tab) {
    // The pop-up was blocked (the link is usually fetched after the click), so open it in this tab instead.
    window.location.assign(url);
    return;
  }
  try {
    tab.opener = null;
  } catch {
    // Already cross-origin: there is no opener to detach.
  }
}

// Whitespace, control, zero-width and bidi characters, and ASCII punctuation other than `._-()`. Other non-ASCII
// characters are kept, so names stay readable.
const UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\s\x00-\x1f\x7f!"#$%&'*+,/:;<=>?@[\\\]^`{|}~\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;

/**
 * A plain file name that is safe as a path on a device: no folders, at most 80 characters before the extension. Android
 * reads the file type from the extension only when the name has no punctuation such as `!` or `'`.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(base)?.[0] ?? '';
  const stem = Array.from(
    base
      .slice(0, base.length - ext.length)
      .replace(UNSAFE, '-')
      .replace(/-{2,}/g, '-'),
  )
    .slice(0, MAX_STEM)
    .join('')
    .replace(/^[.-]+|[.-]+$/g, '');
  return `${stem || 'download'}${ext.toLowerCase()}`;
}

/** Deletes shared copies older than a day. It never throws: the folder may not exist yet, or the OS cleared it. */
async function pruneSharedCopies(): Promise<void> {
  try {
    const { files } = await Filesystem.readdir({ path: SHARE_FOLDER, directory: Directory.Cache });
    const cutoff = Date.now() - KEEP_MS;
    await Promise.allSettled(
      files
        .filter((f) => f.type === 'file' && f.mtime < cutoff)
        .map((f) => Filesystem.deleteFile({ path: `${SHARE_FOLDER}/${f.name}`, directory: Directory.Cache })),
    );
  } catch {
    // Nothing to prune.
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(blob);
  });
}
