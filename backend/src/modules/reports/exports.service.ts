import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Op } from 'sequelize';
import type {
  CreateReportExportInput,
  ReportDownloadDto,
  ReportExportDto,
  ReportExportFormat,
  ReportResultDto,
} from '@erp/shared';
import type { Job } from '../../infrastructure/jobs/job.model';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { audit } from '../../shared/audit/audit.service';
import { getContext, requireTenantContext, runWithContext } from '../../shared/context';
import { AppError, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { FileObject } from '../files/file.model';
import { deleteFile, saveUploadedFile, signedUrlFor } from '../files/files.service';
import { Institute } from '../institutes/institute.model';
import { notify } from '../notifications/api';
import { REPORT_DEFINITIONS, prepareReport, runReport } from './definitions';
import { cleanFilters } from './filters';
import { ReportExport } from './models';
import { renderReport } from './render';
import { fromStoredRequest, toStoredRequest } from './scope';

/** Row limits per table (mutable so tests can exercise the background path with small data). */
export const exportLimits = {
  /** Exports whose tables all fit in this many rows are rendered during the request. */
  sync: 2000,
  /** Rows per table in a background export; larger tables are cut with a note. */
  job: 50_000,
};
/** How long an export file is kept before the expiry job deletes it. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
/** Lifetime of a download link; each download is signed (and audited) separately. */
export const DOWNLOAD_URL_TTL_SECONDS = 300;
/** Queued or running exports a user may have at once (counting the last hour). */
export const MAX_ACTIVE_EXPORTS = 3;

export const EXPORT_JOB = 'reports.export';
export const EXPIRE_JOB = 'reports.expire-export';
export const EXPORT_READY_EVENT = 'reports.export-ready';

const exportRepo = new TenantRepository(ReportExport, { entity: 'Export' });

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const isExpired = (e: ReportExport, now = Date.now()) =>
  e.status === 'expired' || (e.status === 'ready' && (!e.expiresAt || e.expiresAt.getTime() <= now));

export function exportDto(e: ReportExport): ReportExportDto {
  return {
    id: e.id,
    reportKey: e.reportKey,
    title: REPORT_DEFINITIONS.get(e.reportKey)?.title ?? e.reportKey,
    format: e.format,
    status: isExpired(e) ? 'expired' : e.status,
    rowCount: e.rowCount,
    fileName: e.fileName,
    error: e.error,
    filters: e.filters,
    periodLabel: e.scope.period.label,
    scopeLabel: e.scope.scopeLabel,
    createdAt: e.createdAt.toISOString(),
    completedAt: iso(e.completedAt),
    expiresAt: iso(e.expiresAt),
  };
}

const truncated = (result: ReportResultDto) => result.tables.some((t) => t.rows.length < t.totalRows);

interface StoredFile {
  fileId: number;
  fileName: string;
  rowCount: number;
}

/**
 * Renders the result and stores it as a private `reports` file owned by `userId`. The file is
 * institute-level (or on the filtered branch); access goes through the export, never the files API.
 */
async function storeExport(
  result: ReportResultDto,
  format: ReportExportFormat,
  instituteId: number,
  userId: number,
): Promise<StoredFile> {
  const institute = await Institute.findByPk(instituteId);
  const rendered = renderReport(result, format, { instituteName: institute?.name ?? 'Institute' });
  const tempPath = path.join(os.tmpdir(), `report-${crypto.randomUUID()}.${format}`);
  await fs.promises.writeFile(tempPath, rendered.buffer);
  const file = await runWithContext(
    { ...getContext(), instituteId, userId, allowedBranchIds: null, activeBranchId: undefined },
    () =>
      saveUploadedFile({
        tempPath,
        originalName: rendered.fileName,
        mimeType: rendered.mimeType,
        sizeBytes: rendered.buffer.length,
        module: 'reports',
        branchId: result.filters.branchId,
      }),
  );
  return { fileId: file.id, fileName: rendered.fileName, rowCount: result.tables[0]?.rows.length ?? 0 };
}

async function markReady(exp: ReportExport, stored: StoredFile) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXPORT_TTL_MS);
  await exp.update({ ...stored, status: 'ready', error: null, completedAt: now, expiresAt });
  await enqueueJob(EXPIRE_JOB, { exportId: exp.id }, { runAt: expiresAt, instituteId: exp.instituteId });
}

/**
 * Exports a report the caller may open, with their scope. Small reports are rendered now (201,
 * `ready`); larger ones are queued (202) and rendered by a background job up to
 * `exportLimits.job` rows per table.
 */
export async function createExport(
  key: string,
  input: CreateReportExportInput,
): Promise<{ queued: boolean; dto: ReportExportDto }> {
  const ctx = requireTenantContext();
  const userId = ctx.userId!;
  const filters = cleanFilters(input);
  const { def, req } = await prepareReport(key, filters, exportLimits.sync);

  const active = await exportRepo.count({
    userId,
    status: { [Op.in]: ['queued', 'running'] },
    createdAt: { [Op.gt]: new Date(Date.now() - 60 * 60 * 1000) },
  });
  if (active >= MAX_ACTIVE_EXPORTS) {
    throw new AppError(
      429,
      'TOO_MANY_EXPORTS',
      'Wait for your running exports to finish before starting another',
    );
  }

  const result = await runReport(def, req, { exportLimit: exportLimits.sync });
  const queued = truncated(result);
  const stored = queued ? null : await storeExport(result, input.format, ctx.instituteId, userId);
  const exp = await exportRepo.create({
    userId,
    reportKey: def.key,
    format: input.format,
    status: 'queued',
    filters,
    scope: toStoredRequest(req),
    rowCount: null,
    fileId: null,
    fileName: null,
    error: null,
    expiresAt: null,
    completedAt: null,
  });
  if (stored) await markReady(exp, stored);
  else await enqueueJob(EXPORT_JOB, { exportId: exp.id }, { maxAttempts: 3 });

  await audit({
    action: 'report.exported',
    entityType: 'report_export',
    entityId: exp.id,
    metadata: {
      report: def.key,
      format: input.format,
      mode: queued ? 'background' : 'immediate',
      period: { from: req.period.from, to: req.period.to },
      filters,
      scope: req.scopeLabel,
      rows: stored?.rowCount ?? null,
    },
  });
  return { queued, dto: exportDto(exp) };
}

/** Background export: re-runs the stored (access-checked) request with the larger row limit. */
export async function runExportJob(payload: Record<string, unknown>, job: Job): Promise<void> {
  const { instituteId } = requireTenantContext();
  const exp = await ReportExport.findOne({ where: { id: Number(payload.exportId), instituteId } });
  // Ready, failed and expired exports are final; `running` resumes after a crashed attempt.
  if (!exp || (exp.status !== 'queued' && exp.status !== 'running')) return;
  const def = REPORT_DEFINITIONS.get(exp.reportKey);
  try {
    if (!def) throw new Error(`Unknown report ${exp.reportKey}`);
    await exp.update({ status: 'running', error: null });
    const req = fromStoredRequest(exp.scope);
    req.scope.limit = exportLimits.job;
    const result = await runReport(def, req, { exportLimit: exportLimits.job });
    await markReady(exp, await storeExport(result, exp.format, instituteId, exp.userId));
  } catch (err) {
    const final = job.attempts >= job.maxAttempts;
    const message = err instanceof Error ? err.message : String(err);
    await exp.update(
      final
        ? { status: 'failed', error: message.slice(0, 500), completedAt: new Date() }
        : { status: 'queued', error: null },
    );
    throw err;
  }
  try {
    await notify({
      event: EXPORT_READY_EVENT,
      recipients: [exp.userId],
      data: { title: def.title, format: exp.format.toUpperCase(), fileName: exp.fileName, exportId: exp.id },
    });
  } catch (err) {
    logger.warn({ err, exportId: exp.id }, 'Could not send the report export notification');
  }
}

/** Deletes an export's file when its download window closes. */
export async function expireExportJob(payload: Record<string, unknown>): Promise<void> {
  const { instituteId } = requireTenantContext();
  const exp = await ReportExport.findOne({ where: { id: Number(payload.exportId), instituteId } });
  if (!exp || exp.status !== 'ready') return;
  if (exp.expiresAt && exp.expiresAt.getTime() > Date.now()) return;
  if (exp.fileId) {
    try {
      await deleteFile(exp.fileId);
    } catch (err) {
      if (!(err instanceof AppError && err.status === 404)) throw err;
    }
  }
  await exp.update({ status: 'expired', fileId: null });
}

/** The caller's own export (others' exports are 404, including an admin's view of a teacher's). */
async function ownExport(id: number): Promise<ReportExport> {
  const exp = await exportRepo.findOne({ where: { id, userId: requireTenantContext().userId! } });
  if (!exp) throw NotFound('Export');
  return exp;
}

export async function listExports(): Promise<ReportExportDto[]> {
  const rows = await exportRepo.findAll({
    where: { userId: requireTenantContext().userId! },
    order: [['id', 'DESC']],
    limit: 50,
  });
  return rows.map(exportDto);
}

export async function getExport(id: number): Promise<ReportExportDto> {
  return exportDto(await ownExport(id));
}

/** A short-lived signed link to a ready export (409 while pending or failed, 410 once expired). */
export async function downloadExport(id: number): Promise<ReportDownloadDto> {
  const exp = await ownExport(id);
  if (exp.status === 'queued' || exp.status === 'running') {
    throw new AppError(409, 'EXPORT_NOT_READY', 'The export is still being prepared');
  }
  if (exp.status === 'failed') {
    throw new AppError(409, 'EXPORT_FAILED', 'The export failed. Export the report again.');
  }
  const file =
    !isExpired(exp) && exp.fileId
      ? await FileObject.findOne({ where: { id: exp.fileId, instituteId: exp.instituteId } })
      : null;
  if (!file) throw new AppError(410, 'EXPORT_EXPIRED', 'This download has expired. Export the report again.');
  const signed = signedUrlFor(file, DOWNLOAD_URL_TTL_SECONDS);
  await audit({
    action: 'report.export_downloaded',
    entityType: 'report_export',
    entityId: exp.id,
    metadata: { report: exp.reportKey, format: exp.format, fileName: exp.fileName },
  });
  return {
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    fileName: exp.fileName ?? file.originalName,
  };
}
