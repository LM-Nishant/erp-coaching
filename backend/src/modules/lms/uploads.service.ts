import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Op } from 'sequelize';
import {
  LMS_MAX_UPLOAD_BYTES,
  LMS_UPLOAD_CHUNK_BYTES,
  type LmsFileRef,
  type LmsUploadSessionDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { isBlockedUploadType } from '../../shared/utilities/file-response';
import { assertWithinLimit } from '../subscriptions/subscription.service';
import { FileObject } from '../files/file.model';
import { saveUploadedFile, signedUrlFor } from '../files/files.service';
import { LmsUploadSession } from './models';

export const TMP_DIR = path.resolve(__dirname, '../../../tmp/lms-uploads');
const SESSION_TTL_MS = 24 * 3600_000;

export const uploadRepo = new TenantRepository(LmsUploadSession, {
  entity: 'Upload',
  branchScoped: true,
  instituteWideRows: true,
});

export function fileRef(file: FileObject, withUrl = false): LmsFileRef {
  return {
    id: file.id,
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: Number(file.sizeBytes),
    ...(withUrl
      ? (({ url, expiresAt }) => ({ url, expiresAt: expiresAt.toISOString() }))(signedUrlFor(file))
      : {}),
  };
}

const partPath = (uploadId: string) => path.join(TMP_DIR, `${uploadId}.part`);

function toDto(s: LmsUploadSession): LmsUploadSessionDto {
  return {
    uploadId: s.uploadId,
    fileName: s.fileName,
    mimeType: s.mimeType,
    totalBytes: Number(s.totalBytes),
    receivedBytes: Number(s.receivedBytes),
    chunkBytes: LMS_UPLOAD_CHUNK_BYTES,
    status: s.status,
    file: s.file ? fileRef(s.file) : null,
    expiresAt: s.expiresAt.toISOString(),
  };
}

/** Uploads are private to the user who started them. */
async function findMine(uploadId: string): Promise<LmsUploadSession> {
  const { userId } = requireTenantContext();
  const s = await uploadRepo.findOne({
    where: { uploadId, userId: userId! },
    include: [{ model: FileObject, as: 'file' }],
  });
  if (!s) throw NotFound('Upload');
  return s;
}

async function purgeExpired(userId: number) {
  const expired = await uploadRepo.findAll({
    where: { userId, status: 'uploading', expiresAt: { [Op.lt]: new Date() } },
  });
  for (const s of expired) {
    await fsp.rm(partPath(s.uploadId), { force: true });
    await s.update({ status: 'aborted' });
  }
}

export async function startUpload(input: {
  fileName: string;
  mimeType: string;
  totalBytes: number;
  branchId?: number | null;
}): Promise<LmsUploadSessionDto> {
  const { instituteId, userId } = requireTenantContext();
  if (isBlockedUploadType(input.mimeType)) throw BadRequest('This file type is not allowed');
  if (input.totalBytes > LMS_MAX_UPLOAD_BYTES) throw BadRequest('File is too large');
  const used = Number((await FileObject.sum('sizeBytes', { where: { instituteId } })) || 0);
  await assertWithinLimit(instituteId, 'storageMb', used / 1048576, input.totalBytes / 1048576);
  await purgeExpired(userId!);
  uploadRepo.assertBranchAllowed(input.branchId);
  const uploadId = crypto.randomUUID();
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.writeFile(partPath(uploadId), Buffer.alloc(0));
  const s = await uploadRepo.create({
    branchId: input.branchId ?? null,
    uploadId,
    userId: userId!,
    fileName: input.fileName.slice(0, 255),
    mimeType: input.mimeType,
    totalBytes: input.totalBytes,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return toDto(s);
}

export async function getUpload(uploadId: string) {
  return toDto(await findMine(uploadId));
}

/**
 * Appends one chunk. `offset` must equal the bytes already received, so a client that lost a
 * response re-reads the status and resumes from `receivedBytes` (409 `OFFSET_MISMATCH` otherwise).
 */
export async function appendChunk(uploadId: string, offset: number, chunk: Buffer) {
  const mine = await findMine(uploadId);
  if (!chunk.length) throw BadRequest('Empty chunk');
  if (chunk.length > LMS_UPLOAD_CHUNK_BYTES) throw BadRequest('Chunk is too large');
  return getSequelize().transaction(async (transaction) => {
    const s = (await LmsUploadSession.findOne({
      where: { instituteId: mine.instituteId, id: mine.id },
      lock: transaction.LOCK.UPDATE,
      transaction,
    }))!;
    if (s.status !== 'uploading' || s.expiresAt < new Date())
      throw Conflict('Upload is no longer active', 'UPLOAD_CLOSED');
    const received = Number(s.receivedBytes);
    if (offset !== received)
      throw Conflict('Chunk offset does not match the received bytes', 'OFFSET_MISMATCH', {
        receivedBytes: received,
      });
    if (received + chunk.length > Number(s.totalBytes)) throw BadRequest('Chunk exceeds the declared size');
    const fd = await fsp.open(partPath(uploadId), 'r+');
    try {
      await fd.write(chunk, 0, chunk.length, received);
      await fd.truncate(received + chunk.length);
    } finally {
      await fd.close();
    }
    await s.update({ receivedBytes: received + chunk.length }, { transaction });
    return { receivedBytes: received + chunk.length, totalBytes: Number(s.totalBytes) };
  });
}

export async function completeUpload(uploadId: string): Promise<LmsUploadSessionDto> {
  const s = await findMine(uploadId);
  if (s.status === 'completed') return toDto(s);
  if (s.status !== 'uploading') throw Conflict('Upload is no longer active', 'UPLOAD_CLOSED');
  if (Number(s.receivedBytes) !== Number(s.totalBytes))
    throw Conflict('Upload is incomplete', 'UPLOAD_INCOMPLETE', { receivedBytes: Number(s.receivedBytes) });
  const tmp = partPath(uploadId);
  if (!fs.existsSync(tmp)) throw Conflict('Upload data is missing; start again', 'UPLOAD_LOST');
  const file = await saveUploadedFile({
    tempPath: tmp,
    originalName: s.fileName,
    mimeType: s.mimeType,
    sizeBytes: Number(s.totalBytes),
    module: 'lms',
    branchId: s.branchId,
  });
  await s.update({ status: 'completed', fileId: file.id });
  s.file = file;
  await audit({
    action: 'lms.upload.completed',
    entityType: 'file',
    entityId: file.id,
    metadata: { name: file.originalName, size: Number(file.sizeBytes) },
  });
  return toDto(s);
}

export async function abortUpload(uploadId: string): Promise<void> {
  const s = await findMine(uploadId);
  if (s.status !== 'uploading') return;
  await fsp.rm(partPath(uploadId), { force: true });
  await s.update({ status: 'aborted' });
}
