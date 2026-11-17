import { QueryTypes, type Transaction } from 'sequelize';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { Institute } from '../institutes/institute.model';
import { Branch } from '../branches/branch.model';

export type SequenceKind = 'admission' | 'roll';

export interface NumberTarget {
  /** Rendered format with `{SEQ}` still in place; also the counter scope. */
  scopeKey: string;
  width: number;
  kind: SequenceKind;
}

/** Renders every token except `{SEQ}` for the given institute/branch/date. */
export async function resolveNumberTarget(
  kind: SequenceKind,
  format: string,
  branchId: number,
  now = new Date(),
): Promise<NumberTarget> {
  const { instituteId } = requireTenantContext();
  const [inst, branch] = await Promise.all([
    Institute.findByPk(instituteId),
    Branch.findOne({ where: { instituteId, id: branchId } }),
  ]);
  const yyyy = String(now.getFullYear());
  let width = 0;
  const scopeKey = format
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yyyy.slice(2))
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
    .replace(/\{INST\}/g, (inst?.slug ?? 'INST').toUpperCase())
    .replace(/\{BRANCH\}/g, branch?.code ?? 'BR')
    .replace(/\{SEQ(?::(\d{1,2}))?\}/, (_m, w?: string) => {
      width = w ? Number(w) : 0;
      return '{SEQ}';
    });
  return { scopeKey: scopeKey.slice(0, 120), width, kind };
}

/**
 * Makes sure the counter row exists. Runs outside any transaction (autocommit) so that
 * concurrent first allocations don't deadlock on the unique key.
 */
export async function ensureSequence(target: NumberTarget): Promise<void> {
  const { instituteId } = requireTenantContext();
  await getSequelize().query(
    `INSERT IGNORE INTO admission_sequences (institute_id, kind, scope_key, \`last_value\`, created_at, updated_at)
     VALUES (:instituteId, :kind, :scopeKey, 0, NOW(), NOW())`,
    { replacements: { instituteId, kind: target.kind, scopeKey: target.scopeKey }, type: QueryTypes.INSERT },
  );
}

/**
 * Allocates the next number inside the caller's transaction. The UPDATE takes a row lock that is
 * held until commit, so concurrent admissions are serialised and numbers are gap-free and unique.
 */
export async function allocateNumber(target: NumberTarget, transaction: Transaction): Promise<string> {
  const { instituteId } = requireTenantContext();
  const sequelize = getSequelize();
  const replacements = { instituteId, kind: target.kind, scopeKey: target.scopeKey };
  await sequelize.query(
    `UPDATE admission_sequences SET \`last_value\` = \`last_value\` + 1, updated_at = NOW()
     WHERE institute_id = :instituteId AND kind = :kind AND scope_key = :scopeKey`,
    { replacements, transaction, type: QueryTypes.UPDATE },
  );
  const rows = await sequelize.query<{ last_value: number }>(
    `SELECT \`last_value\` FROM admission_sequences
     WHERE institute_id = :instituteId AND kind = :kind AND scope_key = :scopeKey`,
    { replacements, transaction, type: QueryTypes.SELECT },
  );
  if (!rows.length)
    throw new Error(`Sequence ${target.kind}/${target.scopeKey} missing; call ensureSequence first`);
  return target.scopeKey.replace('{SEQ}', String(rows[0].last_value).padStart(target.width, '0'));
}

/** Retries a transactional unit of work on InnoDB deadlocks / lock wait timeouts. */
export async function withLockRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { parent?: { code?: string } }).parent?.code;
      if (i >= attempts || (code !== 'ER_LOCK_DEADLOCK' && code !== 'ER_LOCK_WAIT_TIMEOUT')) throw err;
      await new Promise((r) => setTimeout(r, 20 * i));
    }
  }
}
