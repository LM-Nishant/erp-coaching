import { config } from '../config';
import { LocalDiskStorage } from './local-disk.adapter';
import { S3CompatibleStorage } from './s3.adapter';
import type { StorageAdapter } from './storage.adapter';

export type { StorageAdapter } from './storage.adapter';

let adapter: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (!adapter) {
    adapter =
      config.STORAGE_DRIVER === 'local'
        ? new LocalDiskStorage(config.storageLocalRoot)
        : new S3CompatibleStorage(config.STORAGE_DRIVER);
  }
  return adapter;
}

/** For tests. */
export function setStorage(a: StorageAdapter): void {
  adapter = a;
}
