import { QueryTypes, type Transaction } from 'sequelize';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { Institute } from '../institutes/institute.model';
import { Branch } from '../branches/branch.model';
import { financialYear } from './util';

export type FeeSequenceKind = 'receipt' | 'invoice';

export interface FeeNumberTarget {
  kind: FeeSequenceKind;
  /** Rendered format with `{SEQ}` still in place; also the counter scope. */
  scopeKey: string;
  width: number;
}

/** Renders every token except `{SEQ}`. A missing `{SEQ}` is appended so numbers stay unique. */
export async function resolveFeeNumberTarget(
  kind: FeeSequenceKind,
  format: string,
  branchId: number | null,
  now = new Date(),
): Promise<FeeNumberTarget> {
  const { instituteId } = requireTenantContext();
  const [inst, branch] = await Promise.all([
    Institute.findByPk(instituteId, { attributes: ['slug'] }),
    branchId ? Branch.findOne({ where: { instituteId, id: branchId }, attributes: ['code'] }) : null,
  ]);
  const yyyy = String(now.getFullYear());
  let width = 0;
  let fmt = format.includes('{SEQ') ? format : `${format}{SEQ}`;
  fmt = fmt
    .replace(/\{FY\}/g, financialYear(now))
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yyyy.slice(2))
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
    .replace(/\{INST\}/g, (inst?.slug ?? 'INST').toUpperCase())
    .replace(/\{BRANCH\}/g, branch?.code ?? 'BR')
    .replace(/\{SEQ(?::(\d{1,2}))?\}/, (_m, w?: string) => {
      width = w ? Number(w) : 0;
      return '{SEQ}';
    });
  return { kind, scopeKey: fmt.slice(0, 110), width };
}

/** Creates the counter row outside any transaction so concurrent first uses don't deadlock. */
export async function ensureFeeSequence(target: FeeNumberTarget): Promise<void> {
  const { instituteId } = requireTenantContext();
  await getSequelize().query(
    `INSERT IGNORE INTO fee_sequences (institute_id, kind, scope_key, \`last_value\`, created_at, updated_at)
     VALUES (:instituteId, :kind, :scopeKey, 0, NOW(), NOW())`,
    { replacements: { instituteId, kind: target.kind, scopeKey: target.scopeKey }, type: QueryTypes.INSERT },
  );
}

/**
 * Allocates the next number inside the caller's transaction. The UPDATE row lock is held until
 * commit, so concurrent receipts are serialised per institute/scope: unique and gap-free.
 */
export async function allocateFeeNumber(target: FeeNumberTarget, transaction: Transaction): Promise<string> {
  const { instituteId } = requireTenantContext();
  const sequelize = getSequelize();
  const replacements = { instituteId, kind: target.kind, scopeKey: target.scopeKey };
  await sequelize.query(
    `UPDATE fee_sequences SET \`last_value\` = \`last_value\` + 1, updated_at = NOW()
     WHERE institute_id = :instituteId AND kind = :kind AND scope_key = :scopeKey`,
    { replacements, transaction, type: QueryTypes.UPDATE },
  );
  const rows = await sequelize.query<{ last_value: number }>(
    `SELECT \`last_value\` FROM fee_sequences
     WHERE institute_id = :instituteId AND kind = :kind AND scope_key = :scopeKey`,
    { replacements, transaction, type: QueryTypes.SELECT },
  );
  if (!rows.length) throw new Error(`Fee sequence ${target.kind}/${target.scopeKey} missing`);
  return target.scopeKey.replace('{SEQ}', String(rows[0].last_value).padStart(target.width, '0'));
}
