import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  secure: new Map<string, string>(),
  auth: { me: null as unknown, offline: false },
  api: { offlineLicenses: vi.fn(), offlineLicense: vi.fn(), revokeOffline: vi.fn() },
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: async ({ path }: { path: string }) => {
      if (!h.files.has(path)) throw new Error('File does not exist');
      return { data: h.files.get(path)! };
    },
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      h.files.set(path, data);
      return { uri: path };
    },
    rmdir: async ({ path }: { path: string }) => {
      for (const k of [...h.files.keys()]) if (k.startsWith(`${path}/`)) h.files.delete(k);
    },
  },
}));
vi.mock('@/core/secure-storage', () => ({
  SecureKey: { offlineKeys: 'erp.offline.keys' },
  secureGetJson: async (k: string) => (h.secure.has(k) ? JSON.parse(h.secure.get(k)!) : null),
  secureSetJson: async (k: string, v: unknown) => void h.secure.set(k, JSON.stringify(v)),
}));
vi.mock('@/core/api', () => ({ sessionEndSettled: () => Promise.resolve() }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => h.auth }));
vi.mock('./api', () => ({ lmsApi: h.api }));

import { listOffline, openOffline, saveOffline, syncOffline, wipeOffline } from './offline-store';

const INDEX = 'lms-offline/index.json';
const HOUR = 3600_000;
type Owner = { userId: number; instituteId: number };
type Row = {
  licenseId: number;
  userId?: number | null;
  instituteId?: number | null;
  key?: string;
  expiresAt: string;
};

const A: Owner = { userId: 1, instituteId: 10 };
const A2: Owner = { userId: 1, instituteId: 20 };
const B: Owner = { userId: 2, instituteId: 10 };
const signIn = (o: Owner) => (h.auth.me = { user: { id: o.userId }, institute: { id: o.instituteId } });
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

function row(licenseId: number, owner: Owner | null, expiresIn = HOUR) {
  return {
    licenseId,
    resourceId: licenseId + 100,
    ...(owner ?? {}),
    title: `Lecture ${licenseId}`,
    mimeType: 'video/mp4',
    sizeBytes: 3,
    blocks: 1,
    expiresAt: at(expiresIn),
    watermark: 'Asha · 9430000001',
    savedAt: at(0),
  };
}
function seed(rows: ReturnType<typeof row>[]) {
  h.files.set(INDEX, JSON.stringify(rows));
  for (const r of rows) h.files.set(`lms-offline/${r.licenseId}/0.bin`, 'ciphertext');
  const keys = Object.fromEntries(rows.map((r) => [r.licenseId, `key-${r.licenseId}`]));
  h.secure.set('erp.offline.keys', JSON.stringify({ keys, seenAt: 0 }));
}
const index = () => JSON.parse(h.files.get(INDEX)!) as Row[];
const ring = () => JSON.parse(h.secure.get('erp.offline.keys')!) as { keys: Record<string, string> };
const ids = (rows: { licenseId: number }[]) => rows.map((r) => r.licenseId).sort();
const hasFiles = (licenseId: number) => h.files.has(`lms-offline/${licenseId}/0.bin`);
const licence = (id: number, valid: boolean, expiresAt = at(HOUR)) => ({
  id,
  resourceId: id + 100,
  title: `Lecture ${id}`,
  expiresAt,
  revokedAt: valid ? null : at(0),
  createdAt: at(0),
  contentKey: valid ? `key-${id}` : null,
});

const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/** Saves a lecture through the real download path (AES-GCM included); the server then reports its licence valid. */
async function download(resourceId: number, licenseId: number, text = 'hello video') {
  const contentKey = newKey();
  h.api.offlineLicense.mockResolvedValue({
    ...licence(licenseId, true),
    resourceId,
    contentKey,
    downloadUrl: 'http://api.test/v.mp4',
    downloadUrlExpiresAt: at(HOUR),
    mimeType: 'video/mp4',
    sizeBytes: text.length,
    watermark: { text: 'Asha · 9430000001' },
  });
  const chunks = [new TextEncoder().encode(text)];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => ({ value: chunks.shift(), done: !chunks.length }) }) },
    })),
  );
  await saveOffline(resourceId, () => undefined);
  h.api.offlineLicenses.mockResolvedValue([{ ...licence(licenseId, true), contentKey }]);
  return contentKey;
}

/** Captures the decrypted lecture handed to the player. */
function capturePlayback() {
  let blob: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    blob = b as Blob;
    return 'blob:lecture';
  });
  return () => blob!.text();
}

beforeEach(() => {
  h.files.clear();
  h.secure.clear();
  h.auth.me = null;
  h.auth.offline = false;
  vi.clearAllMocks();
  h.api.revokeOffline.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('offline lectures', () => {
  it('keeps the copies of each account on a shared device apart', async () => {
    seed([row(1, A), row(2, A2), row(3, B)]);
    signIn(A);
    expect(ids(await listOffline())).toEqual([1]);

    // A's licence was revoked on the server; B's copy is not A's to reconcile
    h.api.offlineLicenses.mockResolvedValue([licence(1, false)]);
    await syncOffline();
    expect(ids(index())).toEqual([2, 3]);
    expect(hasFiles(1)).toBe(false);
    expect(ring().keys).not.toHaveProperty('1');

    signIn(B);
    expect(ids(await listOffline())).toEqual([3]);
  });

  it('keeps valid copies on sync, taking the server expiry and restoring a lost key', async () => {
    seed([row(1, A)]);
    h.secure.set('erp.offline.keys', JSON.stringify({ keys: {}, seenAt: 0 }));
    signIn(A);
    const expiresAt = at(30 * 60_000);
    h.api.offlineLicenses.mockResolvedValue([licence(1, true, expiresAt)]);
    await syncOffline();
    expect(index()[0].expiresAt).toBe(expiresAt);
    expect(ring().keys['1']).toBe('key-1');
  });

  it('deletes expired copies of every account', async () => {
    seed([row(1, A, HOUR), row(2, B, HOUR), row(3, B, 3 * HOUR)]);
    signIn(A);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * HOUR);
    expect(await listOffline()).toEqual([]);
    expect(ids(index())).toEqual([3]);
    expect([1, 2].some(hasFiles)).toBe(false);
  });

  it('does not open copies offline once the device clock has been set back, until the server confirms them', async () => {
    signIn(A);
    await download(107, 7);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await listOffline();
    vi.setSystemTime(Date.now() - 24 * HOUR);
    h.auth.offline = true;
    await expect(openOffline(107)).rejects.toThrow(/clock has been set back/);

    h.auth.offline = false;
    const played = capturePlayback();
    await openOffline(107);
    expect(await played()).toBe('hello video');
  });

  it('wipes a user’s copies in every institute, plus copies no account has adopted yet', async () => {
    seed([row(1, A), row(2, A2), row(3, B), row(4, null)]);
    await wipeOffline(1);
    expect(ids(index())).toEqual([3]);
    expect(Object.keys(ring().keys)).toEqual(['3']);
    expect([1, 2, 4].some(hasFiles)).toBe(false);

    await wipeOffline(null);
    expect(index()).toEqual([]);
    expect(hasFiles(3)).toBe(false);
  });

  it('moves keys saved by older versions into secure storage and gives the copies to the signed-in account', async () => {
    h.files.set(INDEX, JSON.stringify([{ ...row(1, null), key: 'legacy-key' }]));
    signIn(A);
    const [item] = await listOffline();
    expect(item).toMatchObject({ licenseId: 1, ...A });
    expect(index()[0]).not.toHaveProperty('key');
    expect(ring().keys['1']).toBe('legacy-key');
  });

  it('encrypts a download at rest and plays it back once the licence checks out', async () => {
    signIn(A);
    const contentKey = await download(107, 7);
    expect(atob(h.files.get('lms-offline/7/0.bin')!)).not.toContain('hello video');
    expect(index()[0]).not.toHaveProperty('key');
    expect(ring().keys['7']).toBe(contentKey);

    const played = capturePlayback();
    const { url, item } = await openOffline(107);
    expect(h.api.offlineLicenses).toHaveBeenCalledTimes(1);
    expect(url).toBe('blob:lecture');
    expect(await played()).toBe('hello video');
    expect(item.watermark).toBe('Asha · 9430000001');

    // without a connection the copy plays without asking the server
    h.auth.offline = true;
    await openOffline(107);
    expect(h.api.offlineLicenses).toHaveBeenCalledTimes(1);
  });

  it('does not play a copy whose licence the server has revoked', async () => {
    seed([row(1, A)]);
    signIn(A);
    h.api.offlineLicenses.mockResolvedValue([licence(1, false)]);
    await expect(openOffline(101)).rejects.toThrow(/not saved offline/);
    expect(hasFiles(1)).toBe(false);
  });

  it('gives the licence back when a download fails', async () => {
    signIn(A);
    h.api.offlineLicense.mockResolvedValue({
      ...licence(9, true),
      contentKey: newKey(),
      downloadUrl: 'http://api.test/v.mp4',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, body: null })),
    );
    await expect(saveOffline(109, () => undefined)).rejects.toThrow('Download failed');
    expect(h.api.revokeOffline).toHaveBeenCalledWith(9);
    expect(await listOffline()).toEqual([]);
  });
});
