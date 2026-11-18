import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Op, type Transaction } from 'sequelize';
import type { DataExportDto, DataExportLinkDto } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { hmac, randomToken, safeEqual } from '../../infrastructure/crypto';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { getStorage } from '../../infrastructure/storage';
import { audit } from '../../shared/audit/audit.service';
import { getContext } from '../../shared/context';
import { Conflict, NotFound } from '../../shared/errors';
import { getInstituteTimezone, nowInZone } from '../../shared/timezone';
import { Institute } from '../institutes/institute.model';
import { notify } from '../notifications/api';
import { User } from '../users/user.model';
import { buildExportArchive } from './archive';
import { DataExport, InstituteDeletionRequest } from './models';

export const EXPORT_JOB = 'tenant-data.export';
export const EXPORT_RETENTION_DAYS = 7;
export const EXPORT_LINK_TTL_SECONDS = 600;
export const MAX_READY_EXPORTS = 3;
const DAY_MS = 86_400_000;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Query options for system code that works across institutes: skips the tenant guard. */
export const platform = <T extends object>(opts: T): T => ({ ...opts, tenantBypass: true }) as T;

export function toExportDto(e: DataExport, now = new Date()): DataExportDto {
  const expired = e.status === 'ready' && (!e.storageKey || (e.expiresAt !== null && e.expiresAt <= now));
  return {
    id: e.id,
    instituteId: e.instituteId,
    status: expired ? 'expired' : e.status,
    includeMedia: !!e.includeMedia,
    requestedBy: e.requestedBy,
    requestedByName: e.requestedByName,
    sizeBytes: e.sizeBytes === null ? null : Number(e.sizeBytes),
    tableCount: e.tableCount,
    rowCount: e.rowCount,
    fileCount: e.fileCount,
    error: e.error,
    completedAt: iso(e.completedAt),
    expiresAt: iso(e.expiresAt),
    createdAt: e.createdAt.toISOString(),
  };
}

/** Display name of the acting user ("Platform support" for a super admin acting directly). */
export async function actorName(transaction?: Transaction): Promise<string | null> {
  const ctx = getContext();
  if (ctx.isSuperAdmin && !ctx.impersonatorId) return 'Platform support';
  if (!ctx.userId) return null;
  const user = await User.findByPk(ctx.userId, { attributes: ['name'], transaction });
  return user?.name ?? null;
}

export async function listExports(instituteId: number): Promise<DataExportDto[]> {
  const rows = await DataExport.findAll({ where: { instituteId }, order: [['id', 'DESC']], limit: 20 });
  const now = new Date();
  return rows.map((r) => toExportDto(r, now));
}

async function findExport(instituteId: number, id: number): Promise<DataExport> {
  const row = await DataExport.findOne({ where: { id, instituteId } });
  if (!row) throw NotFound('Export');
  return row;
}

/** Queues a full export of the institute's data (one at a time; a few finished ones are kept). */
export async function requestExport(
  instituteId: number,
  input: { includeMedia: boolean },
): Promise<DataExportDto> {
  const row = await getSequelize().transaction(async (transaction) => {
    // Serialises with other exports and with the deletion workflow for this institute.
    const institute = await Institute.findByPk(instituteId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!institute) throw NotFound('Institute');
    if (await InstituteDeletionRequest.count({ where: { instituteId, status: 'purging' }, transaction }))
      throw Conflict('This institute is being permanently deleted', 'INSTITUTE_DELETION_IN_PROGRESS');
    const active = await DataExport.count({
      where: { instituteId, status: { [Op.in]: ['pending', 'running'] } },
      transaction,
    });
    if (active) throw Conflict('An export is already being prepared', 'EXPORT_IN_PROGRESS');
    const ready = await DataExport.count({
      where: {
        instituteId,
        status: 'ready',
        storageKey: { [Op.ne]: null },
        expiresAt: { [Op.gt]: new Date() },
      },
      transaction,
    });
    if (ready >= MAX_READY_EXPORTS)
      throw Conflict(
        `At most ${MAX_READY_EXPORTS} exports are kept. Delete an older export first.`,
        'EXPORT_LIMIT',
      );
    return DataExport.create(
      {
        instituteId,
        includeMedia: input.includeMedia,
        requestedBy: getContext().userId ?? null,
        requestedByName: await actorName(transaction),
      },
      { transaction },
    );
  });
  // After commit, so the worker never picks up a job for an uncommitted export.
  await enqueueJob(EXPORT_JOB, { exportId: row.id }, { instituteId, maxAttempts: 1 });
  await audit({
    action: 'tenant_data.export_requested',
    entityType: 'data_export',
    entityId: row.id,
    instituteId,
    metadata: { includeMedia: input.includeMedia },
  });
  return toExportDto(row);
}

async function notifyExportReady(row: DataExport): Promise<void> {
  if (!row.requestedBy || !row.expiresAt) return;
  try {
    const requester = await User.findByPk(row.requestedBy, { attributes: ['id', 'isSuperAdmin'] });
    if (!requester || requester.isSuperAdmin) return;
    const tz = await getInstituteTimezone(row.instituteId);
    await notify({
      event: 'tenant-data.export-ready',
      recipients: [{ userIds: [row.requestedBy] }],
      data: { expiresAt: nowInZone(tz, row.expiresAt).date },
      branchId: null,
    });
  } catch (err) {
    logger.warn({ err, exportId: row.id }, 'Export notification failed');
  }
}

/** Job: builds the archive in a temp file, stores it under the institute's prefix, marks it ready. */
export async function runExportJob(payload: Record<string, unknown>): Promise<void> {
  const instituteId = getContext().instituteId;
  const exportId = Number(payload.exportId);
  if (!instituteId || !Number.isInteger(exportId)) return;
  const [claimed] = await DataExport.update(
    { status: 'running', startedAt: new Date() },
    { where: { id: exportId, instituteId, status: 'pending' } },
  );
  if (!claimed) return;
  const row = await findExport(instituteId, exportId);

  const tmp = path.join(os.tmpdir(), `erp-export-${instituteId}-${exportId}-${randomToken(6)}.zip`);
  try {
    if (await InstituteDeletionRequest.count({ where: { instituteId, status: 'purging' } }))
      throw new Error('The institute is being permanently deleted');
    const result = await buildExportArchive(instituteId, tmp, { exportId, includeMedia: row.includeMedia });
    const key = `institutes/${instituteId}/exports/${exportId}-${randomToken(8)}.zip`;
    await getStorage().putFile(key, tmp, 'application/zip');
    const completedAt = new Date();
    await row.update({
      status: 'ready',
      storageKey: key,
      sizeBytes: result.sizeBytes,
      tableCount: result.tableCount,
      rowCount: result.rowCount,
      fileCount: result.fileCount,
      error: result.missingFiles.length
        ? `${result.missingFiles.length} uploaded file(s) were missing from storage; manifest.json lists them.`
        : null,
      completedAt,
      expiresAt: new Date(completedAt.getTime() + EXPORT_RETENTION_DAYS * DAY_MS),
    });
    await notifyExportReady(row);
  } catch (err) {
    logger.error({ err, exportId, instituteId }, 'Institute data export failed');
    const message = err instanceof Error ? err.message : String(err);
    await row.update({ status: 'failed', error: message.slice(0, 1000), completedAt: new Date() });
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Removes the archive of a finished export and its record. */
export async function deleteExport(instituteId: number, id: number): Promise<void> {
  const row = await findExport(instituteId, id);
  if (row.status === 'pending' || row.status === 'running')
    throw Conflict('Wait for the export to finish before deleting it', 'EXPORT_IN_PROGRESS');
  if (row.storageKey) await getStorage().delete(row.storageKey);
  await row.destroy();
  await audit({ action: 'tenant_data.export_deleted', entityType: 'data_export', entityId: id, instituteId });
}

// ------------------------------------------------------------------ signed download links

interface ExportClaims {
  /** export id */
  x: number;
  /** institute id */
  i: number;
  /** user who created the link */
  u: number | null;
  /** expiry (unix seconds) */
  e: number;
}

const secret = () => `${config.FILE_URL_SECRET}:tenant-export`;

function verifyExportToken(token: string): ExportClaims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body, secret()))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as ExportClaims;
    if (!Number.isInteger(c.x) || !Number.isInteger(c.i) || typeof c.e !== 'number') return null;
    return c.e < Date.now() / 1000 ? null : c;
  } catch {
    return null;
  }
}

const isDownloadable = (row: DataExport, now = new Date()) =>
  row.status === 'ready' && !!row.storageKey && !!row.expiresAt && row.expiresAt > now;

/** A link valid for a few minutes; the archive itself is the credential-free payload. */
export async function createExportLink(instituteId: number, id: number): Promise<DataExportLinkDto> {
  const row = await findExport(instituteId, id);
  if (!isDownloadable(row)) throw Conflict('This export is not available for download', 'EXPORT_NOT_READY');
  const expiry = Math.min(
    Math.floor(Date.now() / 1000) + EXPORT_LINK_TTL_SECONDS,
    Math.floor(row.expiresAt!.getTime() / 1000),
  );
  const claims: ExportClaims = { x: row.id, i: instituteId, u: getContext().userId ?? null, e: expiry };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${body}.${hmac(body, secret())}`;
  await audit({
    action: 'tenant_data.export_link_created',
    entityType: 'data_export',
    entityId: row.id,
    instituteId,
  });
  return {
    url: `${config.API_PUBLIC_URL}/api/tenant-data/public/exports/${token}`,
    expiresAt: new Date(expiry * 1000).toISOString(),
  };
}

/** Resolves a signed link to the archive stream (404 for anything invalid, expired or deleted). */
export async function openExportDownload(
  token: string,
): Promise<{ stream: Readable; size: number; fileName: string }> {
  const c = verifyExportToken(token);
  if (!c) throw NotFound('Export');
  const row = await DataExport.findOne({ where: { id: c.x, instituteId: c.i } });
  if (!row || !isDownloadable(row)) throw NotFound('Export');
  const stat = await getStorage().stat(row.storageKey!);
  if (!stat) throw NotFound('Export');
  const institute = await Institute.findByPk(c.i, { attributes: ['slug'] });
  const slug = (institute?.slug ?? `institute-${c.i}`).replace(/[^A-Za-z0-9-]+/g, '-');
  const date = (row.completedAt ?? row.createdAt).toISOString().slice(0, 10);
  await audit({
    action: 'tenant_data.export_downloaded',
    entityType: 'data_export',
    entityId: row.id,
    instituteId: c.i,
    metadata: { linkCreatedBy: c.u },
  });
  return {
    stream: await getStorage().getStream(row.storageKey!),
    size: stat.size,
    fileName: `${slug}-export-${date}.zip`,
  };
}

// ------------------------------------------------------------------ housekeeping

/** Deletes archives past their retention and fails exports whose job died. */
export async function sweepExports(now = new Date()): Promise<{ expired: number; failed: number }> {
  let expired = 0;
  const due = await DataExport.findAll(
    platform({ where: { status: 'ready', storageKey: { [Op.ne]: null }, expiresAt: { [Op.lte]: now } } }),
  );
  for (const row of due) {
    try {
      await getStorage().delete(row.storageKey!);
      await row.update({ storageKey: null });
      expired++;
    } catch (err) {
      logger.warn({ err, exportId: row.id }, 'Could not delete an expired export');
    }
  }
  const [failed] = await DataExport.update(
    { status: 'failed', error: 'The export did not finish in time. Please try again.', completedAt: now },
    platform({
      where: {
        status: { [Op.in]: ['pending', 'running'] },
        createdAt: { [Op.lte]: new Date(now.getTime() - 6 * 3_600_000) },
      },
    }),
  );
  return { expired, failed };
}
