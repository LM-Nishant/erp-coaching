import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getStorage } from '../../infrastructure/storage';
import { config } from '../../infrastructure/config';
import { signFileToken } from '../../infrastructure/storage/signed-url';
import { requireTenantContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { assertWithinLimit } from '../subscriptions/subscription.service';
import { FileObject } from './file.model';

export const fileRepo = new TenantRepository(FileObject, {
  entity: 'File',
  branchScoped: true,
  instituteWideRows: true,
});

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function buildStorageKey(instituteId: number, originalName: string, now = new Date()) {
  const ext = path
    .extname(originalName)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '')
    .slice(0, 10);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `institutes/${instituteId}/${now.getUTCFullYear()}/${mm}/${crypto.randomUUID()}${ext}`;
}

export interface SaveUploadInput {
  tempPath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  module: string;
  branchId?: number | null;
}

/**
 * Public API for other modules: persist an uploaded temp file for the current tenant.
 * Enforces the plan storage quota, writes through the storage adapter and records metadata.
 */
export async function saveUploadedFile(input: SaveUploadInput): Promise<FileObject> {
  const { instituteId, userId } = requireTenantContext();
  try {
    const usedBytes = Number((await FileObject.sum('sizeBytes', { where: { instituteId } })) || 0);
    await assertWithinLimit(instituteId, 'storageMb', usedBytes / 1048576, input.sizeBytes / 1048576);
    const storage = getStorage();
    const key = buildStorageKey(instituteId, input.originalName);
    const checksum = await sha256File(input.tempPath);
    await storage.putFile(key, input.tempPath, input.mimeType);
    return await fileRepo.create({
      branchId: input.branchId ?? null,
      ownerUserId: userId ?? null,
      module: input.module,
      storageDriver: storage.driver,
      storageKey: key,
      originalName: input.originalName.slice(0, 255),
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      checksumSha256: checksum,
    });
  } finally {
    await fs.promises.rm(input.tempPath, { force: true });
  }
}

/**
 * File purposes (`files.module`) whose files carry module-level access rules (paid LMS content,
 * exam answer scans, live recordings, receipts, payslips, HR/student documents, tickets…). Their
 * owning module signs them through its own permission-checked routes; the generic
 * `GET /files/:id/url` only signs them for the uploader. Add a purpose here when a module stores
 * access-controlled files.
 */
export const MODULE_OWNED_FILE_PURPOSES: ReadonlySet<string> = new Set([
  'lms',
  'exams',
  'question-bank',
  'live-classes',
  'fees',
  'payroll',
  'hr',
  'students',
  'grievances',
  'admissions',
  'appointments',
  'parent-portal',
  'reports',
]);

export const isModuleOwnedPurpose = (purpose: string) => MODULE_OWNED_FILE_PURPOSES.has(purpose);

/** Short-lived URL usable directly in <img>/<video>/download links. */
export function signedUrlFor(file: FileObject, ttlSeconds = config.SIGNED_URL_TTL_SECONDS) {
  const { token, expiresAt } = signFileToken(file.id, file.instituteId, ttlSeconds);
  return { url: `${config.API_PUBLIC_URL}/api/files/signed/${token}`, expiresAt };
}

export async function deleteFile(id: number) {
  const file = await fileRepo.findById(id);
  fileRepo.assertRowWritable(file);
  await getStorage().delete(file.storageKey);
  await file.destroy();
}
