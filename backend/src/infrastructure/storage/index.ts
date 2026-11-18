import { config } from '../config';
import { LocalDiskStorage } from './local-disk.adapter';
import { S3CompatibleStorage, type S3Connection } from './s3.adapter';
import type { StorageAdapter } from './storage.adapter';

export type { StorageAdapter } from './storage.adapter';
export type { S3Connection } from './s3.adapter';

let adapter: StorageAdapter | null = null;

/** Builds an adapter; S3/R2 take the connection configured by the super admin. */
export function createStorageAdapter(
  driver: StorageAdapter['driver'],
  connection: S3Connection = {},
): StorageAdapter {
  return driver === 'local'
    ? new LocalDiskStorage(config.storageLocalRoot)
    : new S3CompatibleStorage(driver, connection);
}

export function getStorage(): StorageAdapter {
  if (!adapter) adapter = createStorageAdapter(config.STORAGE_DRIVER);
  return adapter;
}

/** Replaces the active adapter (platform storage settings, tests); `null` restores the env default. */
export function setStorage(a: StorageAdapter | null): void {
  adapter = a;
}
