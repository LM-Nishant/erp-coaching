import { Op, fn, col, type Transaction, type WhereOptions } from 'sequelize';
import { LEDGER_ACCOUNTS } from '@erp/shared';
import { getContext, requireTenantContext } from '../../shared/context';
import { FeeLedgerEntry } from './models';
import { today } from './util';

export const L = LEDGER_ACCOUNTS;
export const bankLedger = (bankAccountId: number) => `bank:${bankAccountId}`;
export const gatewayLedger = (gateway: string) => `gateway:${gateway}`;
export const expenseLedger = (categoryId: number) => `expense:${categoryId}`;
export const incomeLedger = (categoryId: number) => `income:${categoryId}`;

export interface JournalLine {
  account: string;
  debit?: number;
  credit?: number;
}

export interface Journal {
  /** Unique business key (e.g. `payment:12`); posting the same key twice is a no-op. */
  key: string;
  date?: string;
  branchId?: number | null;
  feeAccountId?: number | null;
  refType: string;
  refId?: number | null;
  narration?: string;
  lines: JournalLine[];
}

/**
 * Posts a balanced double-entry journal inside the caller's transaction. Idempotent: if the
 * journal key already exists nothing is written and `false` is returned. The unique index on
 * (institute_id, journal_key, line) is the final guard against concurrent duplicate postings.
 */
export async function postJournal(j: Journal, transaction: Transaction): Promise<boolean> {
  const { instituteId } = requireTenantContext();
  const lines = j.lines
    .map((l) => ({ account: l.account, debit: Math.round(l.debit ?? 0), credit: Math.round(l.credit ?? 0) }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  if (!lines.length) return false;
  for (const l of lines)
    if (l.debit < 0 || l.credit < 0 || (l.debit && l.credit))
      throw new Error(`Invalid ledger line for ${l.account} in ${j.key}`);
  const dr = lines.reduce((s, l) => s + l.debit, 0);
  const cr = lines.reduce((s, l) => s + l.credit, 0);
  if (dr !== cr) throw new Error(`Unbalanced journal ${j.key}: debit ${dr} ≠ credit ${cr}`);
  const exists = await FeeLedgerEntry.findOne({
    where: { instituteId, journalKey: j.key },
    attributes: ['id'],
    transaction,
  });
  if (exists) return false;
  const userId = getContext().userId ?? null;
  const entryDate = j.date ?? (await today());
  await FeeLedgerEntry.bulkCreate(
    lines.map((l, i) => ({
      instituteId,
      branchId: j.branchId ?? null,
      journalKey: j.key,
      line: i + 1,
      entryDate,
      account: l.account,
      debit: l.debit,
      credit: l.credit,
      feeAccountId: j.feeAccountId ?? null,
      refType: j.refType,
      refId: j.refId ?? null,
      narration: j.narration?.slice(0, 255) ?? null,
      createdByUserId: userId,
    })),
    { transaction },
  );
  return true;
}

/** Debit − credit per ledger account (optionally for a period / fee account / branch). */
export async function ledgerBalances(
  filter: {
    from?: string;
    to?: string;
    feeAccountId?: number;
    branchId?: number;
    accountPrefix?: string;
  } = {},
): Promise<Record<string, { debit: number; credit: number; balance: number }>> {
  const { instituteId } = requireTenantContext();
  const where: Record<string | symbol, unknown> = { instituteId };
  if (filter.from || filter.to)
    where.entryDate = {
      ...(filter.from ? { [Op.gte]: filter.from } : {}),
      ...(filter.to ? { [Op.lte]: filter.to } : {}),
    };
  if (filter.feeAccountId) where.feeAccountId = filter.feeAccountId;
  if (filter.branchId) where.branchId = filter.branchId;
  if (filter.accountPrefix) where.account = { [Op.like]: `${filter.accountPrefix}%` };
  const rows = (await FeeLedgerEntry.findAll({
    where: where as WhereOptions<FeeLedgerEntry>,
    attributes: ['account', [fn('SUM', col('debit')), 'dr'], [fn('SUM', col('credit')), 'cr']],
    group: ['account'],
    raw: true,
  })) as unknown as { account: string; dr: string; cr: string }[];
  return Object.fromEntries(
    rows.map((r) => {
      const debit = Number(r.dr ?? 0);
      const credit = Number(r.cr ?? 0);
      return [r.account, { debit, credit, balance: debit - credit }];
    }),
  );
}
