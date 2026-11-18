import type { Readable } from 'node:stream';
import type { StorageAdapter, StoredObjectInfo } from './storage.adapter';

/** Connection configured by the super admin (Platform settings → Storage). */
export interface S3Connection {
  bucket?: string;
  region?: string;
  /** Custom endpoint (R2 / S3-compatible services). */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * Placeholder for AWS S3 / Cloudflare R2 (S3-compatible). Implement with @aws-sdk/client-s3 using
 * `connection`. Intentionally throws so misconfiguration is obvious (and the super admin's
 * connection test fails, which keeps the driver from being activated).
 */
export class S3CompatibleStorage implements StorageAdapter {
  constructor(
    readonly driver: 's3' | 'r2',
    readonly connection: S3Connection = {},
  ) {}
  private fail(): never {
    throw new Error(`Storage driver "${this.driver}" is not implemented yet`);
  }
  putFile(): Promise<StoredObjectInfo> {
    return this.fail();
  }
  putBuffer(): Promise<StoredObjectInfo> {
    return this.fail();
  }
  getStream(): Promise<Readable> {
    return this.fail();
  }
  stat(): Promise<{ size: number } | null> {
    return this.fail();
  }
  delete(): Promise<void> {
    return this.fail();
  }
}
