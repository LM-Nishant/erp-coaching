import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageAdapter, StoredObjectInfo } from './storage.adapter';

export class LocalDiskStorage implements StorageAdapter {
  readonly driver = 'local' as const;

  constructor(private readonly root: string) {}

  /** Resolves a key inside the root, rejecting traversal. */
  resolve(key: string): string {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Storage key escapes root');
    return full;
  }

  async putFile(key: string, sourcePath: string): Promise<StoredObjectInfo> {
    const dest = this.resolve(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(sourcePath, dest);
    } catch {
      await fsp.copyFile(sourcePath, dest);
      await fsp.unlink(sourcePath).catch(() => undefined);
    }
    const { size } = await fsp.stat(dest);
    return { key, size };
  }

  async putBuffer(key: string, data: Buffer): Promise<StoredObjectInfo> {
    const dest = this.resolve(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, data);
    return { key, size: data.length };
  }

  async getStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return fs.createReadStream(this.resolve(key), range);
  }

  async stat(key: string) {
    try {
      const s = await fsp.stat(this.resolve(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await fsp.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/')) throw new Error(`Storage prefix must end with "/": ${prefix}`);
    const dir = this.resolve(prefix.slice(0, -1));
    let count: number;
    try {
      const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
      count = entries.filter((e) => e.isFile()).length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    await fsp.rm(dir, { recursive: true, force: true });
    return count;
  }
}
