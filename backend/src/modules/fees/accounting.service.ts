import { Op, type WhereOptions } from 'sequelize';
import type {
  BankAccountDto,
  BankStatementLineDto,
  FinanceEntryDto,
  FinanceEntryKind,
  OfflinePaymentMode,
  ProfitLossDto,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest, Conflict } from '../../shared/errors';
import { requireTenantContext } from '../../shared/context';
import {
  BankAccount,
  BankStatementLine,
  FeeAccount,
  FeeInstalment,
  FeeLedgerEntry,
  FeePayment,
  FinanceCategory,
  FinanceEntry,
} from './models';
import { FileObject } from '../files/file.model';
import { L, bankLedger, expenseLedger, incomeLedger, ledgerBalances, postJournal } from './ledger';
import { addDays, today } from './util';
import { accountRepo } from './accounts.service';
import { paymentRepo } from './payments.service';

export const bankRepo = new TenantRepository(BankAccount, {
  branchScoped: true,
  instituteWideRows: true,
  entity: 'Bank account',
});
export const categoryRepo = new TenantRepository(FinanceCategory, { entity: 'Category' });
export const entryRepo = new TenantRepository(FinanceEntry, {
  branchScoped: true,
  instituteWideRows: true,
  entity: 'Finance entry',
});
export const statementRepo = new TenantRepository(BankStatementLine, { entity: 'Statement line' });

export async function bankAccountDto(b: BankAccount, withBalance = true): Promise<BankAccountDto> {
  let balance: number | undefined;
  if (withBalance) {
    const bal = await ledgerBalances({ accountPrefix: bankLedger(b.id) });
    balance = b.openingBalance + (bal[bankLedger(b.id)]?.balance ?? 0);
  }
  return {
    id: b.id,
    branchId: b.branchId,
    name: b.name,
    bankName: b.bankName,
    accountNumberLast4: b.accountNumberLast4,
    ifsc: b.ifsc,
    openingBalance: b.openingBalance,
    active: b.active,
    balance,
  };
}

export function entryDto(e: FinanceEntry): FinanceEntryDto {
  return {
    id: e.id,
    branchId: e.branchId,
    kind: e.kind,
    categoryId: e.categoryId,
    date: e.entryDate,
    amount: e.amount,
    tax: e.tax,
    mode: e.mode,
    bankAccountId: e.bankAccountId,
    party: e.party,
    reference: e.reference,
    notes: e.notes,
    attachmentFileId: e.attachmentFileId,
    status: e.status,
    createdAt: e.createdAt.toISOString(),
  };
}

export function statementDto(l: BankStatementLine): BankStatementLineDto {
  return {
    id: l.id,
    bankAccountId: l.bankAccountId,
    txnDate: l.txnDate,
    description: l.description,
    reference: l.reference,
    amount: l.amount,
    status: l.status,
    matchedType: l.matchedType,
    matchedId: l.matchedId,
  };
}

const entryMoneyLedger = (mode: OfflinePaymentMode, bankAccountId: number | null) =>
  mode === 'cash' ? L.CASH : bankAccountId ? bankLedger(bankAccountId) : L.UNDEPOSITED;

export interface FinanceEntryInput {
  kind: FinanceEntryKind;
  categoryId: number;
  date?: string;
  amount: number;
  tax?: number;
  mode: OfflinePaymentMode;
  bankAccountId?: number | null;
  branchId?: number | null;
  party?: string | null;
  reference?: string | null;
  notes?: string | null;
  attachmentFileId?: number | null;
}

/** Records an expense or other income and its journal (expense: Dr expense / Cr cash|bank). */
export async function createFinanceEntry(input: FinanceEntryInput) {
  const { instituteId, userId } = requireTenantContext();
  const category = await categoryRepo.findById(input.categoryId);
  if (category.kind !== input.kind) throw BadRequest(`Category is not an ${input.kind} category`);
  if (input.mode !== 'cash' && input.bankAccountId) await bankRepo.findById(input.bankAccountId);
  if (input.attachmentFileId) {
    if (
      !(await FileObject.findOne({ where: { instituteId, id: input.attachmentFileId }, attributes: ['id'] }))
    )
      throw BadRequest('Attachment not found');
  }
  return getSequelize().transaction(async (transaction) => {
    const e = await entryRepo.create(
      {
        branchId: input.branchId ?? null,
        kind: input.kind,
        categoryId: category.id,
        entryDate: input.date ?? today(),
        amount: input.amount,
        tax: input.tax ?? 0,
        mode: input.mode,
        bankAccountId: input.mode === 'cash' ? null : (input.bankAccountId ?? null),
        party: input.party ?? null,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        attachmentFileId: input.attachmentFileId ?? null,
        recordedByUserId: userId ?? null,
      },
      { transaction },
    );
    const moneyAcc = entryMoneyLedger(e.mode, e.bankAccountId);
    const catAcc = e.kind === 'expense' ? expenseLedger(category.id) : incomeLedger(category.id);
    await postJournal(
      {
        key: `finance:${e.id}`,
        date: e.entryDate,
        branchId: e.branchId,
        refType: 'finance_entry',
        refId: e.id,
        narration: `${category.name}${e.party ? ` – ${e.party}` : ''}`,
        lines:
          e.kind === 'expense'
            ? [
                { account: catAcc, debit: e.amount },
                { account: moneyAcc, credit: e.amount },
              ]
            : [
                { account: moneyAcc, debit: e.amount },
                { account: catAcc, credit: e.amount },
              ],
      },
      transaction,
    );
    return e;
  });
}

export async function cancelFinanceEntry(id: number) {
  const e = await entryRepo.findById(id);
  entryRepo.assertRowWritable(e);
  if (e.status === 'cancelled') throw Conflict('Entry already cancelled', 'ALREADY_CANCELLED');
  const moneyAcc = entryMoneyLedger(e.mode, e.bankAccountId);
  const catAcc = e.kind === 'expense' ? expenseLedger(e.categoryId) : incomeLedger(e.categoryId);
  await getSequelize().transaction(async (transaction) => {
    await e.update({ status: 'cancelled' }, { transaction });
    await postJournal(
      {
        key: `finance-cancel:${e.id}`,
        branchId: e.branchId,
        refType: 'finance_entry',
        refId: e.id,
        narration: 'Entry cancelled',
        lines:
          e.kind === 'expense'
            ? [
                { account: moneyAcc, debit: e.amount },
                { account: catAcc, credit: e.amount },
              ]
            : [
                { account: catAcc, debit: e.amount },
                { account: moneyAcc, credit: e.amount },
              ],
      },
      transaction,
    );
  });
  return e;
}

/** Income & expenditure / P&L for a period, derived from the ledger. */
export async function profitAndLoss(from: string, to: string, branchId?: number): Promise<ProfitLossDto> {
  const { instituteId } = requireTenantContext();
  const bal = await ledgerBalances({ from, to, branchId });
  const cats = await FinanceCategory.findAll({ where: { instituteId } });
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const credit = (acc: string) => -(bal[acc]?.balance ?? 0);
  const debit = (acc: string) => bal[acc]?.balance ?? 0;
  const income: ProfitLossDto['income'] = [
    { label: 'Fee income (net of GST)', amount: credit(L.FEE_INCOME) },
    { label: 'Late fees', amount: credit(L.LATE_FEE_INCOME) },
    { label: 'Other income', amount: credit(L.OTHER_INCOME) },
  ];
  const expenditure: ProfitLossDto['expenditure'] = [
    { label: 'Discounts, concessions & scholarships', amount: debit(L.DISCOUNTS) },
    { label: 'Payment gateway charges', amount: debit(L.GATEWAY_CHARGES) },
    { label: 'Expenses (uncategorised)', amount: debit(L.EXPENSES) },
  ];
  for (const [acc, v] of Object.entries(bal)) {
    const m = /^(income|expense):(\d+)$/.exec(acc);
    if (!m) continue;
    const label = catName.get(Number(m[2])) ?? acc;
    if (m[1] === 'income') income.push({ label, amount: -v.balance });
    else expenditure.push({ label, amount: v.balance });
  }
  const inc = income.filter((x) => x.amount !== 0);
  const exp = expenditure.filter((x) => x.amount !== 0);
  const totalIncome = inc.reduce((s, x) => s + x.amount, 0);
  const totalExpenditure = exp.reduce((s, x) => s + x.amount, 0);
  return {
    from,
    to,
    income: inc,
    expenditure: exp,
    totalIncome,
    totalExpenditure,
    net: totalIncome - totalExpenditure,
  };
}

/** Daily cash book: opening cash, receipts/payments on the day, closing cash, collections by mode. */
export async function dailyCashReport(date: string, branchId?: number) {
  const { instituteId } = requireTenantContext();
  const where: Record<string, unknown> = { instituteId, account: L.CASH };
  if (branchId) where.branchId = branchId;
  const before = await ledgerBalances({ to: addDays(date, -1), branchId, accountPrefix: L.CASH });
  const opening = before[L.CASH]?.balance ?? 0;
  const rows = await FeeLedgerEntry.findAll({
    where: { ...where, entryDate: date } as WhereOptions<FeeLedgerEntry>,
    order: [['id', 'ASC']],
  });
  const cashIn = rows.reduce((s, r) => s + r.debit, 0);
  const cashOut = rows.reduce((s, r) => s + r.credit, 0);
  const payments = await paymentRepo.findAll({
    where: {
      paidOn: date,
      status: { [Op.in]: ['successful', 'partially_refunded', 'refunded'] },
      ...(branchId ? { branchId } : {}),
    },
  });
  const byMode: Record<string, number> = {};
  for (const p of payments)
    byMode[p.gateway ? `online:${p.gateway}` : p.mode] =
      (byMode[p.gateway ? `online:${p.gateway}` : p.mode] ?? 0) + p.amount;
  return {
    date,
    opening,
    cashIn,
    cashOut,
    closing: opening + cashIn - cashOut,
    collectionsByMode: byMode,
    totalCollections: payments.reduce((s, p) => s + p.amount, 0),
    rows: rows.map((r) => ({
      journalKey: r.journalKey,
      narration: r.narration,
      refType: r.refType,
      refId: r.refId,
      in: r.debit,
      out: r.credit,
    })),
  };
}

/** Successful collections in a period (receipt-wise). */
export async function collectionsReport(f: { from: string; to: string; branchId?: number; mode?: string }) {
  const where: Record<string | symbol, unknown> = {
    paidOn: { [Op.between]: [f.from, f.to] },
    status: { [Op.in]: ['successful', 'partially_refunded', 'refunded'] },
  };
  if (f.branchId) where.branchId = f.branchId;
  if (f.mode) where.mode = f.mode;
  const rows = await paymentRepo.findAll({
    where: where as WhereOptions<FeePayment>,
    include: ['student', 'receipt'],
    order: [
      ['paidOn', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const items = rows.map((p) => ({
    date: p.paidOn!,
    receiptNo: p.receipt?.number ?? '',
    student: p.student?.name ?? '',
    admissionNumber: p.student?.admissionNumber ?? '',
    mode: p.gateway ? `online (${p.gateway})` : p.mode,
    reference: p.gatewayPaymentId ?? p.referenceNo ?? p.chequeNumber ?? '',
    amount: p.amount,
    gatewayCharge: p.gatewayCharge,
    refunded: p.refunded,
    net: p.amount - p.refunded,
  }));
  const totals = {
    amount: items.reduce((s, x) => s + x.amount, 0),
    refunded: items.reduce((s, x) => s + x.refunded, 0),
    gatewayCharges: items.reduce((s, x) => s + x.gatewayCharge, 0),
    net: items.reduce((s, x) => s + x.net, 0),
  };
  return { from: f.from, to: f.to, items, totals };
}

/** Accounts with dues, with the overdue part as of `asOf`. */
export async function outstandingReport(f: {
  asOf?: string;
  branchId?: number;
  batchId?: number;
  courseId?: number;
}) {
  const asOf = f.asOf ?? today();
  const where: Record<string, unknown> = { status: 'active' };
  if (f.branchId) where.branchId = f.branchId;
  if (f.batchId) where.batchId = f.batchId;
  if (f.courseId) where.courseId = f.courseId;
  const accounts = await accountRepo.findAll({
    where: where as WhereOptions<FeeAccount>,
    include: ['student', 'instalments'],
  });
  const items = accounts
    .filter((a) => a.balance > 0)
    .map((a) => {
      const due = (a.instalments ?? []).filter((i: FeeInstalment) => i.balance > 0 && i.dueDate <= asOf);
      return {
        accountId: a.id,
        student: a.student?.name ?? '',
        admissionNumber: a.student?.admissionNumber ?? '',
        mobile: a.student?.mobile ?? '',
        title: a.title,
        net: a.net,
        paid: a.paid,
        balance: a.balance,
        overdue: due.reduce((s, i) => s + i.balance, 0),
        oldestDueDate: due.map((i) => i.dueDate).sort()[0] ?? null,
      };
    })
    .sort((x, y) => y.overdue - x.overdue || y.balance - x.balance);
  return {
    asOf,
    items,
    totals: {
      balance: items.reduce((s, x) => s + x.balance, 0),
      overdue: items.reduce((s, x) => s + x.overdue, 0),
    },
  };
}

export async function importStatement(
  bankAccountId: number,
  lines: { date: string; description?: string; reference?: string; amount: number }[],
) {
  const bank = await bankRepo.findById(bankAccountId);
  const { instituteId } = requireTenantContext();
  const rows = await BankStatementLine.bulkCreate(
    lines.map((l) => ({
      instituteId,
      bankAccountId: bank.id,
      txnDate: l.date,
      description: l.description?.slice(0, 255) ?? null,
      reference: l.reference?.slice(0, 100) ?? null,
      amount: l.amount,
    })),
  );
  return rows;
}

/** Candidate book entries for an unmatched statement line (same bank, amount, ±5 days). */
export async function matchSuggestions(lineId: number) {
  const line = await statementRepo.findById(lineId);
  const from = addDays(line.txnDate, -5);
  const to = addDays(line.txnDate, 5);
  const matchedPayments = (
    await statementRepo.findAll({ where: { matchedType: 'payment' }, attributes: ['matchedId'] })
  ).map((l) => l.matchedId!);
  const matchedEntries = (
    await statementRepo.findAll({ where: { matchedType: 'finance_entry' }, attributes: ['matchedId'] })
  ).map((l) => l.matchedId!);
  const payments =
    line.amount > 0
      ? await paymentRepo.findAll({
          where: {
            amount: line.amount,
            bankAccountId: line.bankAccountId,
            status: { [Op.in]: ['successful', 'partially_refunded'] },
            paidOn: { [Op.between]: [from, to] },
            ...(matchedPayments.length ? { id: { [Op.notIn]: matchedPayments } } : {}),
          },
          include: ['student'],
        })
      : [];
  const entries = await entryRepo.findAll({
    where: {
      kind: line.amount > 0 ? 'income' : 'expense',
      amount: Math.abs(line.amount),
      bankAccountId: line.bankAccountId,
      status: 'recorded',
      entryDate: { [Op.between]: [from, to] },
      ...(matchedEntries.length ? { id: { [Op.notIn]: matchedEntries } } : {}),
    },
  });
  return {
    payments: payments.map((p) => ({
      id: p.id,
      date: p.paidOn,
      amount: p.amount,
      student: p.student?.name,
      reference: p.referenceNo,
    })),
    entries: entries.map(entryDto),
  };
}

export async function reconcileLine(
  lineId: number,
  input: { action: 'match' | 'ignore' | 'unmatch'; type?: 'payment' | 'finance_entry'; id?: number },
) {
  const line = await statementRepo.findById(lineId);
  if (input.action === 'ignore')
    return line.update({ status: 'ignored', matchedType: null, matchedId: null });
  if (input.action === 'unmatch')
    return line.update({ status: 'unmatched', matchedType: null, matchedId: null });
  if (!input.type || !input.id) throw BadRequest('type and id are required to match');
  if (input.type === 'payment') {
    const p = await paymentRepo.findById(input.id);
    if (Math.abs(p.amount) !== Math.abs(line.amount))
      throw BadRequest('Amount does not match the statement line');
  } else {
    const e = await entryRepo.findById(input.id);
    if (e.amount !== Math.abs(line.amount)) throw BadRequest('Amount does not match the statement line');
  }
  const dup = await statementRepo.findOne({
    where: { matchedType: input.type, matchedId: input.id, id: { [Op.ne]: line.id } },
  });
  if (dup) throw Conflict('That entry is already matched to another statement line', 'ALREADY_MATCHED');
  return line.update({ status: 'matched', matchedType: input.type, matchedId: input.id });
}
