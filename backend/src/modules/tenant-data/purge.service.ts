import { QueryTypes } from 'sequelize';
import type { DeletionSummaryDto } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { logger } from '../../infrastructure/logger';
import { getStorage } from '../../infrastructure/storage';
import { clearInstituteTimezoneCache } from '../../shared/timezone';
import {
  chunk,
  deletionOrder,
  foreignKeys,
  ident,
  instituteUserIds,
  tenantTablePlan,
  userReferenceColumns,
  withoutSuperAdmins,
} from './catalog';

const DELETE_BATCH = 5000;
const VERIFY_ROUNDS = 3;
/** ER_ROW_IS_REFERENCED_2: a RESTRICT foreign key blocked the delete. */
const FK_RESTRICT_ERRNOS = new Set([1451, 1217]);

function isFkRestrict(err: unknown): boolean {
  const e = err as { parent?: { errno?: number }; original?: { errno?: number }; errno?: number };
  const errno = e?.parent?.errno ?? e?.original?.errno ?? e?.errno;
  return errno !== undefined && FK_RESTRICT_ERRNOS.has(errno);
}

async function deleteInstituteRows(table: string, instituteId: number): Promise<number> {
  let total = 0;
  for (;;) {
    const affected = await getSequelize().query(
      `DELETE FROM ${ident(table)} WHERE institute_id = :instituteId LIMIT ${DELETE_BATCH}`,
      { type: QueryTypes.BULKDELETE, replacements: { instituteId } },
    );
    const n = Number(affected) || 0;
    total += n;
    if (n < DELETE_BATCH) return total;
  }
}

/** Deletes the tables child-first; tables a foreign key still blocks are retried in later passes. */
async function deleteTables(tables: string[], instituteId: number, counts: Record<string, number>) {
  let remaining = tables;
  while (remaining.length) {
    const blocked: string[] = [];
    for (const table of remaining) {
      try {
        const n = await deleteInstituteRows(table, instituteId);
        if (n) counts[table] = (counts[table] ?? 0) + n;
      } catch (err) {
        if (!isFkRestrict(err)) throw err;
        blocked.push(table);
      }
    }
    if (blocked.length === remaining.length)
      throw new Error(`Foreign keys prevent deleting rows of: ${blocked.join(', ')}`);
    remaining = blocked;
  }
}

async function tablesWithRows(tables: string[], instituteId: number): Promise<string[]> {
  const left: string[] = [];
  for (const table of tables) {
    const [row] = await getSequelize().query<{ n: number }>(
      `SELECT EXISTS(SELECT 1 FROM ${ident(table)} WHERE institute_id = :instituteId) AS n`,
      { type: QueryTypes.SELECT, replacements: { instituteId } },
    );
    if (Number(row?.n)) left.push(table);
  }
  return left;
}

/** Users the institute's rows refer to; collected before anything is deleted. */
export async function purgeCandidateUsers(instituteId: number): Promise<number[]> {
  const plan = await tenantTablePlan();
  return instituteUserIds(
    instituteId,
    plan.map((t) => t.table),
    await foreignKeys(),
  );
}

/**
 * Permanently deletes an institute: its uploaded files, every row of every tenant table (except
 * operator records such as SaaS invoices, which are detached), the institute itself and the user
 * accounts that belonged to no other institute. Idempotent, so a failed purge can be retried.
 * `candidateUserIds` are the accounts its rows referred to (see `purgeCandidateUsers`).
 */
export async function purgeInstitute(
  instituteId: number,
  candidateUserIds: number[],
): Promise<DeletionSummaryDto> {
  const sequelize = getSequelize();
  const plan = await tenantTablePlan();
  const fks = await foreignKeys();
  const purgeTables = plan.filter((t) => t.purge).map((t) => t.table);
  const retainedTables = plan.filter((t) => !t.purge).map((t) => t.table);
  const counts: Record<string, number> = {};

  // Queued work for the institute would otherwise run against half-deleted data.
  await sequelize.query("DELETE FROM jobs WHERE institute_id = :instituteId AND status = 'pending'", {
    type: QueryTypes.BULKDELETE,
    replacements: { instituteId },
  });

  // Files first: once the rows are gone nothing would point at objects outside the institute prefix.
  const storage = getStorage();
  const prefix = `institutes/${instituteId}/`;
  let files = 0;
  if (purgeTables.includes('files')) {
    const outside = await sequelize.query<{ k: string }>(
      'SELECT DISTINCT storage_key AS k FROM files WHERE institute_id = :instituteId AND storage_key NOT LIKE :prefix',
      { type: QueryTypes.SELECT, replacements: { instituteId, prefix: `${prefix}%` } },
    );
    for (const { k } of outside) {
      if (!(await storage.stat(k))) continue;
      await storage.delete(k);
      files++;
    }
  }
  files += await storage.deletePrefix(prefix);

  const order = deletionOrder(purgeTables, fks);
  for (let round = 1; ; round++) {
    await deleteTables(order, instituteId, counts);
    // Rows written concurrently (a request or job still in flight) are caught by another round.
    const left = await tablesWithRows(order, instituteId);
    if (!left.length) break;
    if (round >= VERIFY_ROUNDS) throw new Error(`Rows remain after deletion in: ${left.join(', ')}`);
    logger.warn({ instituteId, left }, 'Rows reappeared during institute purge; deleting again');
  }

  const retained = await tablesWithRows(
    retainedTables.filter((t) => t !== 'institute_deletion_requests'),
    instituteId,
  );
  // Retained tables reference the institute with ON DELETE SET NULL; everything else is gone.
  await sequelize.query('DELETE FROM institutes WHERE id = :instituteId', {
    type: QueryTypes.BULKDELETE,
    replacements: { instituteId },
  });
  clearInstituteTimezoneCache(instituteId);

  const users = await removeUsers(candidateUserIds, purgeTables, fks);
  return {
    tables: counts,
    files,
    users: users.deleted,
    anonymizedUsers: users.anonymized,
    retainedTables: retained,
  };
}

/**
 * Deletes the institute's former users unless another institute still refers to them; accounts
 * that some other record still references are anonymised instead.
 */
async function removeUsers(
  candidates: number[],
  instituteTables: string[],
  fks: Awaited<ReturnType<typeof foreignKeys>>,
): Promise<{ deleted: number; anonymized: number }> {
  const sequelize = getSequelize();
  const ids = await withoutSuperAdmins(candidates);
  const stillMembers = new Set<number>();
  const refs = userReferenceColumns(fks, new Set(instituteTables));
  for (const part of chunk(ids, 1000)) {
    for (const f of refs) {
      const rows = await sequelize.query<{ u: number }>(
        `SELECT DISTINCT ${ident(f.column)} AS u FROM ${ident(f.table)} WHERE ${ident(f.column)} IN (:ids)`,
        { type: QueryTypes.SELECT, replacements: { ids: part } },
      );
      for (const r of rows) stillMembers.add(Number(r.u));
    }
  }

  let deleted = 0;
  let anonymized = 0;
  const removable = ids.filter((id) => !stillMembers.has(id));
  const deleteUsers = async (batch: number[]) =>
    Number(
      await sequelize.query('DELETE FROM users WHERE id IN (:ids) AND is_super_admin = 0', {
        type: QueryTypes.BULKDELETE,
        replacements: { ids: batch },
      }),
    ) || 0;
  for (const batch of chunk(removable, 500)) {
    try {
      deleted += await deleteUsers(batch);
    } catch (err) {
      if (!isFkRestrict(err)) throw err;
      for (const id of batch) {
        try {
          deleted += await deleteUsers([id]);
        } catch (e) {
          if (!isFkRestrict(e)) throw e;
          await sequelize.query(
            `UPDATE users SET name = 'Deleted user', mobile = :mobile, email = NULL, password_hash = NULL,
                    status = 'blocked' WHERE id = :id AND is_super_admin = 0`,
            { type: QueryTypes.BULKUPDATE, replacements: { id, mobile: `deleted-${id}` } },
          );
          anonymized++;
        }
      }
    }
  }
  return { deleted, anonymized };
}
