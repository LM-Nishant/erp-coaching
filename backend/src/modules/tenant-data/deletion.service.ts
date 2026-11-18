import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { SYSTEM_ROLES, type DeletionRequestDto, type DeletionRequestStatus } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { Job } from '../../infrastructure/jobs/job.model';
import { logger } from '../../infrastructure/logger';
import { audit } from '../../shared/audit/audit.service';
import { getContext, runWithContext } from '../../shared/context';
import { AppError, Conflict, NotFound } from '../../shared/errors';
import { getInstituteTimezone, nowInZone } from '../../shared/timezone';
import { Institute } from '../institutes/institute.model';
import { notify, registerNotificationEvents } from '../notifications/api';
import { actorName, sweepExports } from './export.service';
import { DataExport, InstituteDeletionRequest } from './models';
import { purgeCandidateUsers, purgeInstitute } from './purge.service';

export const PURGE_JOB = 'tenant-data.purge';
export const TENANT_DATA_SWEEP_JOB = 'tenant-data.sweep';
export const DEFAULT_GRACE_DAYS = 30;
const SWEEP_INTERVAL_MS = 3_600_000;
const STUCK_PURGE_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;
const OPEN_STATUSES: DeletionRequestStatus[] = ['pending', 'approved', 'purging'];

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toDeletionDto(r: InstituteDeletionRequest): DeletionRequestDto {
  return {
    id: r.id,
    instituteId: r.instituteId,
    instituteName: r.instituteName,
    instituteSlug: r.instituteSlug,
    status: r.status,
    reason: r.reason,
    requestedBy: r.requestedBy,
    requestedByName: r.requestedByName,
    decidedBy: r.decidedBy,
    decidedAt: iso(r.decidedAt),
    decisionNote: r.decisionNote,
    scheduledFor: iso(r.scheduledFor),
    completedAt: iso(r.completedAt),
    summary: r.summary,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Audited without an institute id: the institute's own audit trail is deleted by the purge. */
async function auditDeletion(
  action: string,
  r: InstituteDeletionRequest,
  metadata: Record<string, unknown> = {},
) {
  await audit({
    action,
    entityType: 'institute_deletion_request',
    entityId: r.id,
    instituteId: null,
    metadata: {
      instituteId: r.instituteRefId,
      instituteName: r.instituteName,
      instituteSlug: r.instituteSlug,
      requestId: r.id,
      ...metadata,
    },
  });
}

// ------------------------------------------------------------------ notifications

export function registerTenantDataNotificationEvents() {
  const event = (key: string, label: string, variables: string[], title: string, body: string) => ({
    key,
    label,
    category: 'Account',
    variables,
    title,
    body,
    defaultChannels: ['in_app', 'push', 'email'] as ('in_app' | 'push' | 'email')[],
    defaultRecipientTypes: ['staff' as const],
  });
  registerNotificationEvents([
    event(
      'tenant-data.export-ready',
      'Data export ready',
      ['expiresAt'],
      'Your data export is ready',
      'The export of all {{institute.name}} data is ready. Download it from Data export & deletion before {{expiresAt}}.',
    ),
    {
      ...event(
        'tenant-data.deletion-requested',
        'Institute deletion requested',
        ['requestedBy'],
        'Deletion of {{institute.name}} was requested',
        '{{requestedBy}} asked to permanently delete {{institute.name}} and all its data. Platform support will review the request; until then it can be cancelled from Data export & deletion.',
      ),
      mandatory: true,
    },
    {
      ...event(
        'tenant-data.deletion-scheduled',
        'Institute deletion scheduled',
        ['date'],
        '{{institute.name}} will be deleted on {{date}}',
        'The request to delete {{institute.name}} was approved. The account is deactivated and all its data will be permanently deleted on {{date}}. Contact support before then to cancel the deletion or to get a copy of your data.',
      ),
      mandatory: true,
    },
  ]);
}

async function notifyAdmins(instituteId: number, event: string, data: Record<string, unknown>) {
  try {
    await runWithContext({ system: true, instituteId, allowedBranchIds: null }, () =>
      notify({ event, recipients: [{ role: SYSTEM_ROLES.INSTITUTE_ADMIN }], data, branchId: null }),
    );
  } catch (err) {
    logger.warn({ err, event, instituteId }, 'Tenant data notification failed');
  }
}

// ------------------------------------------------------------------ requests

export async function latestDeletionRequest(instituteId: number): Promise<DeletionRequestDto | null> {
  const r = await InstituteDeletionRequest.findOne({ where: { instituteId }, order: [['id', 'DESC']] });
  return r ? toDeletionDto(r) : null;
}

/**
 * Starts the deletion workflow. `confirm` must repeat the institute's code (slug) so the request is
 * deliberate; nothing is deleted until a super admin approves and the grace period passes.
 */
export async function requestDeletion(
  instituteId: number,
  input: { confirm: string; reason?: string | null },
): Promise<DeletionRequestDto> {
  const row = await getSequelize().transaction(async (transaction) => {
    const institute = await Institute.findByPk(instituteId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!institute) throw NotFound('Institute');
    if (input.confirm.trim().toLowerCase() !== institute.slug.toLowerCase())
      throw new AppError(400, 'CONFIRMATION_MISMATCH', 'Type the institute code exactly to confirm');
    const open = await InstituteDeletionRequest.count({
      where: { instituteId, status: { [Op.in]: OPEN_STATUSES } },
      transaction,
    });
    if (open)
      throw Conflict('A deletion request is already open for this institute', 'DELETION_REQUEST_OPEN');
    return InstituteDeletionRequest.create(
      {
        instituteId,
        instituteRefId: instituteId,
        instituteName: institute.name,
        instituteSlug: institute.slug,
        reason: input.reason?.trim() || null,
        requestedBy: getContext().userId ?? null,
        requestedByName: await actorName(transaction),
      },
      { transaction },
    );
  });
  await auditDeletion('institute.deletion_requested', row, {
    reason: row.reason,
    actorName: row.requestedByName,
  });
  await notifyAdmins(instituteId, 'tenant-data.deletion-requested', {
    requestedBy: row.requestedByName ?? 'An administrator',
  });
  return toDeletionDto(row);
}

/** The institute withdraws its own request while it awaits review. */
export async function cancelOwnDeletionRequest(instituteId: number): Promise<DeletionRequestDto> {
  const row = await InstituteDeletionRequest.findOne({
    where: { instituteId, status: 'pending' },
    order: [['id', 'DESC']],
  });
  if (!row) throw NotFound('Pending deletion request');
  await row.update({
    status: 'cancelled',
    decidedBy: getContext().userId ?? null,
    decidedAt: new Date(),
    decisionNote: 'Cancelled by the institute',
  });
  await auditDeletion('institute.deletion_cancelled', row, { by: 'institute' });
  return toDeletionDto(row);
}

export async function listDeletionRequests(q: {
  status?: DeletionRequestStatus;
  search?: string;
  page: number;
  pageSize: number;
}) {
  const where: WhereOptions<InstituteDeletionRequest> = {};
  if (q.status) Object.assign(where, { status: q.status });
  if (q.search)
    Object.assign(where, {
      [Op.or]: [
        { instituteName: { [Op.like]: `%${q.search}%` } },
        { instituteSlug: { [Op.like]: `%${q.search}%` } },
      ],
    });
  const { rows, count } = await InstituteDeletionRequest.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  return { items: rows.map(toDeletionDto), total: count, page: q.page, pageSize: q.pageSize };
}

/** Locks the request (and its institute) for a state change. */
async function decide<T>(
  id: number,
  allowed: DeletionRequestStatus[],
  change: (
    row: InstituteDeletionRequest,
    institute: Institute | null,
    transaction: Transaction,
  ) => Promise<T>,
): Promise<{ row: InstituteDeletionRequest; result: T }> {
  return getSequelize().transaction(async (transaction) => {
    const row = await InstituteDeletionRequest.findByPk(id, { lock: transaction.LOCK.UPDATE, transaction });
    if (!row) throw NotFound('Deletion request');
    if (!allowed.includes(row.status))
      throw Conflict(`The request is ${row.status}`, 'DELETION_REQUEST_STATE', { status: row.status });
    const institute = row.instituteId
      ? await Institute.findByPk(row.instituteId, { lock: transaction.LOCK.UPDATE, transaction })
      : null;
    return { row, result: await change(row, institute, transaction) };
  });
}

/**
 * Super admin approval: the institute is deactivated at once (its users can no longer sign in) and
 * permanently deleted when the grace period ends, unless the request is cancelled before then.
 */
export async function approveDeletion(
  id: number,
  input: { graceDays: number; note?: string | null },
): Promise<DeletionRequestDto> {
  const now = new Date();
  const { row } = await decide(id, ['pending'], async (r, institute, transaction) => {
    if (!institute) throw NotFound('Institute');
    await r.update(
      {
        status: 'approved',
        decidedBy: getContext().userId ?? null,
        decidedAt: now,
        decisionNote: input.note?.trim() || null,
        previousInstituteStatus: institute.status,
        scheduledFor: new Date(now.getTime() + input.graceDays * DAY_MS),
      },
      { transaction },
    );
    if (institute.status !== 'inactive') await institute.update({ status: 'inactive' }, { transaction });
  });
  await auditDeletion('institute.deletion_approved', row, {
    graceDays: input.graceDays,
    scheduledFor: iso(row.scheduledFor),
    note: row.decisionNote,
  });
  const tz = await getInstituteTimezone(row.instituteRefId);
  await notifyAdmins(row.instituteRefId, 'tenant-data.deletion-scheduled', {
    date: nowInZone(tz, row.scheduledFor!).date,
  });
  if (input.graceDays === 0) await startDuePurges(new Date());
  return toDeletionDto(await row.reload());
}

export async function rejectDeletion(
  id: number,
  input: { note?: string | null },
): Promise<DeletionRequestDto> {
  const { row } = await decide(id, ['pending'], (r, _institute, transaction) =>
    r.update(
      {
        status: 'rejected',
        decidedBy: getContext().userId ?? null,
        decidedAt: new Date(),
        decisionNote: input.note?.trim() || null,
      },
      { transaction },
    ),
  );
  await auditDeletion('institute.deletion_rejected', row, { note: row.decisionNote });
  return toDeletionDto(row);
}

/** Cancels a pending or approved request; an institute deactivated by the approval is restored. */
export async function cancelDeletion(
  id: number,
  input: { note?: string | null },
): Promise<DeletionRequestDto> {
  const { row, result: restored } = await decide(
    id,
    ['pending', 'approved'],
    async (r, institute, transaction) => {
      const wasApproved = r.status === 'approved';
      await r.update(
        {
          status: 'cancelled',
          decidedBy: getContext().userId ?? null,
          decidedAt: new Date(),
          decisionNote: input.note?.trim() || r.decisionNote,
        },
        { transaction },
      );
      if (wasApproved && institute?.status === 'inactive') {
        const status = (r.previousInstituteStatus as Institute['status'] | null) ?? 'active';
        await institute.update({ status }, { transaction });
        return status;
      }
      return null;
    },
  );
  await auditDeletion('institute.deletion_cancelled', row, { by: 'platform', restoredStatus: restored });
  return toDeletionDto(row);
}

/** Runs a failed purge again (it is idempotent and continues where it stopped). */
export async function retryDeletion(id: number): Promise<DeletionRequestDto> {
  const { row } = await decide(id, ['failed'], (r, _institute, transaction) =>
    r.update({ status: 'approved', scheduledFor: new Date(), error: null }, { transaction }),
  );
  await auditDeletion('institute.deletion_retried', row);
  await startDuePurges(new Date());
  return toDeletionDto(await row.reload());
}

// ------------------------------------------------------------------ purge

/** Moves approved requests whose grace period has ended to `purging` and queues the purge. */
export async function startDuePurges(now = new Date()): Promise<number> {
  const due = await InstituteDeletionRequest.findAll({
    where: { status: 'approved', scheduledFor: { [Op.lte]: now } },
    order: [['scheduledFor', 'ASC']],
  });
  let started = 0;
  for (const candidate of due) {
    const outcome = await getSequelize().transaction(async (transaction) => {
      const row = await InstituteDeletionRequest.findByPk(candidate.id, {
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      if (!row || row.status !== 'approved' || !row.scheduledFor || row.scheduledFor > now) return null;
      if (row.instituteId) {
        const institute = await Institute.findByPk(row.instituteId, {
          lock: transaction.LOCK.UPDATE,
          transaction,
        });
        if (institute?.status === 'active') {
          // A super admin reactivated the institute during the grace period.
          await row.update(
            { status: 'cancelled', decisionNote: 'Cancelled: the institute was reactivated' },
            { transaction },
          );
          return { row, action: 'cancelled' as const };
        }
        const exporting = await DataExport.count({
          where: { instituteId: row.instituteId, status: { [Op.in]: ['pending', 'running'] } },
          transaction,
        });
        if (exporting) return null; // next sweep
      }
      await row.update({ status: 'purging', startedAt: now, error: null }, { transaction });
      return { row, action: 'purging' as const };
    });
    if (!outcome) continue;
    if (outcome.action === 'cancelled') {
      await auditDeletion('institute.deletion_cancelled', outcome.row, { by: 'reactivation' });
      continue;
    }
    await enqueueJob(PURGE_JOB, { requestId: outcome.row.id }, { instituteId: null, maxAttempts: 1 });
    await auditDeletion('institute.purge_started', outcome.row);
    started++;
  }
  return started;
}

/** Job: permanently deletes the institute of a `purging` request and records what was removed. */
export async function runPurgeJob(payload: Record<string, unknown>): Promise<void> {
  const row = await InstituteDeletionRequest.findByPk(Number(payload.requestId));
  if (!row || row.status !== 'purging') return;
  const instituteId = row.instituteRefId;
  try {
    const institute = await Institute.findByPk(instituteId);
    if (institute?.status === 'active') {
      await row.update({ status: 'cancelled', decisionNote: 'Cancelled: the institute was reactivated' });
      await auditDeletion('institute.deletion_cancelled', row, { by: 'reactivation' });
      return;
    }
    if (institute) {
      const found = await purgeCandidateUsers(instituteId);
      const pending = [...new Set([...(row.pendingUserIds ?? []), ...found])].sort((a, b) => a - b);
      await row.update({ pendingUserIds: pending });
    }
    const summary = await purgeInstitute(instituteId, row.pendingUserIds ?? []);
    await row.update({
      status: 'completed',
      completedAt: new Date(),
      summary,
      pendingUserIds: null,
      instituteId: null,
    });
    await auditDeletion('institute.purged', row, {
      rows: Object.values(summary.tables).reduce((a, b) => a + b, 0),
      tables: Object.keys(summary.tables).length,
      files: summary.files,
      users: summary.users,
      anonymizedUsers: summary.anonymizedUsers,
      retainedTables: summary.retainedTables,
    });
  } catch (err) {
    logger.error({ err, requestId: row.id, instituteId }, 'Institute purge failed');
    const message = err instanceof Error ? err.message : String(err);
    await row.update({ status: 'failed', error: message.slice(0, 2000) });
    await auditDeletion('institute.purge_failed', row, { error: message.slice(0, 500) });
  }
}

// ------------------------------------------------------------------ sweep

export async function runTenantDataSweep(now = new Date()) {
  const exports = await sweepExports(now);
  const [stuckPurges] = await InstituteDeletionRequest.update(
    { status: 'failed', error: 'The purge did not finish. Retry it to continue.' },
    { where: { status: 'purging', startedAt: { [Op.lte]: new Date(now.getTime() - STUCK_PURGE_MS) } } },
  );
  const purgesStarted = await startDuePurges(now);
  return { expiredExports: exports.expired, failedExports: exports.failed, purgesStarted, stuckPurges };
}

export async function scheduleTenantDataSweep(): Promise<void> {
  const pending = await Job.findOne({ where: { name: TENANT_DATA_SWEEP_JOB, status: 'pending' } });
  if (pending) return;
  await enqueueJob(
    TENANT_DATA_SWEEP_JOB,
    {},
    { instituteId: null, runAt: new Date(Date.now() + SWEEP_INTERVAL_MS) },
  );
}

export async function tenantDataSweepJob(): Promise<void> {
  try {
    await runTenantDataSweep();
  } finally {
    await scheduleTenantDataSweep();
  }
}
