import type { Readable } from 'node:stream';

export interface StoredObjectInfo {
  key: string;
  size: number;
}

/**
 * Storage abstraction (spec §8). Keys are always tenant-prefixed: `institutes/<id>/...`.
 * Implementations must never expose permanent public URLs; access goes through signed API URLs.
 */
export interface StorageAdapter {
  readonly driver: 'local' | 's3' | 'r2';
  putFile(key: string, sourcePath: string, contentType: string): Promise<StoredObjectInfo>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<StoredObjectInfo>;
  getStream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  stat(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object under `prefix` (e.g. `institutes/7/`); returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}
