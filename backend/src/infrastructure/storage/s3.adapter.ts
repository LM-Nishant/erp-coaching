import type { Readable } from 'node:stream';
import type { StorageAdapter, StoredObjectInfo } from './storage.adapter';

/**
 * Placeholder for AWS S3 / Cloudflare R2 (S3-compatible). Implement with @aws-sdk/client-s3 when
 * Super Admin storage configuration is built. Intentionally throws so misconfiguration is obvious.
 */
export class S3CompatibleStorage implements StorageAdapter {
  constructor(readonly driver: 's3' | 'r2') {}
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
