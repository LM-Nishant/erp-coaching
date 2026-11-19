import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFileLink, safeFileName, saveFile } from './downloads';

const h = vi.hoisted(() => ({
  native: false,
  writeFile: vi.fn(async (_options: object) => ({ uri: 'file:///data/cache/downloads/shared.pdf' })),
  readdir: vi.fn(async (_options: object) => ({
    files: [] as { name: string; type: 'file' | 'directory'; mtime: number }[],
  })),
  deleteFile: vi.fn(async (_options: object) => undefined),
  share: vi.fn(async (_options: object) => ({ activityType: 'com.apple.DocumentManagerUICore.SaveToFiles' })),
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { writeFile: h.writeFile, readdir: h.readdir, deleteFile: h.deleteFile },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: h.share } }));

beforeEach(() => {
  h.native = false;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('saveFile on the web', () => {
  it('downloads through a temporary link, keeping the name as given', async () => {
    vi.useFakeTimers();
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: { download: string; href: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href, attached: this.isConnected });
    });

    expect(await saveFile('a,b\n1,2\n', 'Fee report: May.csv', 'text/csv')).toBe('downloaded');

    expect(clicked).toEqual([{ download: 'Fee report: May.csv', href: 'blob:report', attached: true }]);
    expect(document.querySelector('a')).toBeNull();
    const blob = created.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/csv');
    expect(await blob.text()).toBe('a,b\n1,2\n');
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revoked).toHaveBeenCalledWith('blob:report');
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.share).not.toHaveBeenCalled();
  });
});

describe('saveFile on a device', () => {
  beforeEach(() => {
    h.native = true;
  });

  it('writes a copy to the app cache under a safe name and opens the share sheet', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');

    expect(await saveFile(new Blob(['%PDF-1.7']), '../Scorecard #12.pdf')).toBe('shared');

    expect(h.writeFile).toHaveBeenCalledWith({
      path: 'downloads/Scorecard-12.pdf',
      data: btoa('%PDF-1.7'),
      directory: 'CACHE',
      recursive: true,
    });
    expect(h.share).toHaveBeenCalledWith({
      title: 'Scorecard-12.pdf',
      files: ['file:///data/cache/downloads/shared.pdf'],
      dialogTitle: 'Scorecard-12.pdf',
    });
    expect(click).not.toHaveBeenCalled();
  });

  it('treats a closed share sheet as cancelled and reports other failures', async () => {
    h.share.mockRejectedValueOnce(new Error('Share canceled'));
    expect(await saveFile('a,b\n', 'report.csv', 'text/csv')).toBe('cancelled');

    h.share.mockRejectedValueOnce(new Error("Can't share while sharing is in progress"));
    await expect(saveFile('a,b\n', 'report.csv', 'text/csv')).rejects.toThrow('sharing is in progress');
  });

  it('deletes shared copies older than a day, and saves even when the folder cannot be read', async () => {
    const now = Date.now();
    h.readdir.mockResolvedValueOnce({
      files: [
        { name: 'old.csv', type: 'file', mtime: now - 25 * 3_600_000 },
        { name: 'recent.csv', type: 'file', mtime: now - 3_600_000 },
      ],
    });
    await saveFile('x', 'report.csv');
    expect(h.readdir).toHaveBeenCalledWith({ path: 'downloads', directory: 'CACHE' });
    expect(h.deleteFile).toHaveBeenCalledTimes(1);
    expect(h.deleteFile).toHaveBeenCalledWith({ path: 'downloads/old.csv', directory: 'CACHE' });

    h.readdir.mockRejectedValueOnce(new Error('Folder does not exist.'));
    expect(await saveFile('x', 'report.csv')).toBe('shared');
  });
});

describe('safeFileName', () => {
  it.each([
    ['attendance-students-2026-05-01-2026-05-31.csv', 'attendance-students-2026-05-01-2026-05-31.csv'],
    ['Fee report: May 2026 (draft).XLSX', 'Fee-report-May-2026-(draft).xlsx'],
    ["Ravi's #1 report!.pdf", 'Ravi-s-1-report.pdf'],
    ['रिपोर्ट मई.csv', 'रिपोर्ट-मई.csv'],
    ['invoice\u202efdp.exe', 'invoice-fdp.exe'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\exports\\report.csv', 'report.csv'],
    ['.csv', 'download.csv'],
    ['...', 'download'],
    ['', 'download'],
  ])('%j becomes %j', (name, expected) => {
    expect(safeFileName(name)).toBe(expected);
  });

  it('shortens a long name but keeps its extension', () => {
    expect(safeFileName(`${'a'.repeat(200)}.pdf`)).toBe(`${'a'.repeat(80)}.pdf`);
  });
});

describe('openFileLink', () => {
  const url = 'https://api.example.test/api/files/signed/token';

  it('opens a new tab on the web and detaches it from the app', () => {
    const tab = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);

    openFileLink(url);

    expect(open).toHaveBeenCalledWith(url, '_blank');
    expect(tab.opener).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it('opens the link in the same tab when the pop-up is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);

    openFileLink(url);

    expect(assign).toHaveBeenCalledWith(url);
  });

  it('hands the link to the system browser on a device', () => {
    h.native = true;
    const open = vi.spyOn(window, 'open');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);

    openFileLink(url);

    expect(assign).toHaveBeenCalledWith(url);
    expect(open).not.toHaveBeenCalled();
  });
});
