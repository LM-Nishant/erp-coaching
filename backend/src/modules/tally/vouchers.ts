import { createHash } from 'node:crypto';
import {
  LEDGER_ACCOUNTS as L,
  type TallyGstLedgers,
  type TallyMappingConflictDto,
  type TallyReceivableMode,
  type TallyVoucherTypeKey,
  type TallyVoucherTypes,
} from '@erp/shared';
import {
  GST_HEADS,
  effectiveParent,
  findConflicts,
  isCashBankGroup,
  resolveAccount,
  type KnownList,
  type MappingLookups,
  type Overrides,
} from './mapping';
import type { TallyMasterJson, TallyTotalJson } from './models';

/** A fee ledger row as read for an export. */
export interface LedgerRow {
  id: number;
  journalKey: string;
  line: number;
  entryDate: string;
  branchId: number | null;
  account: string;
  debit: number;
  credit: number;
  feeAccountId: number | null;
  refType: string;
  refId: number | null;
  narration: string | null;
  createdAt: Date | null;
}

/** The rows of one journal (one `postJournal` call). */
export interface JournalGroup {
  key: string;
  entryDate: string;
  branchId: number | null;
  feeAccountId: number | null;
  refType: string;
  refId: number | null;
  narration: string | null;
  /** When the journal was posted. */
  recordedAt: Date | null;
  rows: LedgerRow[];
}

/** Groups ledger rows into journals, ordered by date and posting order. */
export function groupJournals(rows: LedgerRow[]): JournalGroup[] {
  const byKey = new Map<string, JournalGroup>();
  for (const r of rows) {
    let j = byKey.get(r.journalKey);
    if (!j) {
      j = {
        key: r.journalKey,
        entryDate: r.entryDate,
        branchId: r.branchId,
        feeAccountId: r.feeAccountId,
        refType: r.refType,
        refId: r.refId,
        narration: r.narration,
        recordedAt: r.createdAt,
        rows: [],
      };
      byKey.set(r.journalKey, j);
    }
    j.rows.push(r);
    if (r.createdAt && (!j.recordedAt || r.createdAt > j.recordedAt)) j.recordedAt = r.createdAt;
  }
  const journals = [...byKey.values()];
  for (const j of journals) j.rows.sort((a, b) => a.line - b.line || a.id - b.id);
  return journals.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.rows[0].id - b.rows[0].id);
}

/** Journals that undo an earlier one with the same reference (refund, cancellation, reversal). */
export const REVERSAL_PREFIXES = [
  'refund:',
  'payment-cancel:',
  'payment-coupon-reversal:',
  'finance-cancel:',
  'account-cancel:',
] as const;
export const isReversal = (journalKey: string) => REVERSAL_PREFIXES.some((p) => journalKey.startsWith(p));

/** Journals that raise a student's dues; with no cash/bank line they use the fee charge voucher type. */
const FEE_CHARGE_PREFIXES = ['charge:', 'late-fee:', 'adjustment:'];

/** Journal key prefix → voucher number prefix (refund and cancel suffixes such as `:gst` are kept). */
const NUMBER_PREFIXES: readonly (readonly [string, string])[] = [
  ['payment-coupon-reversal:', 'CPNR'],
  ['payment-coupon:', 'CPN'],
  ['payment-cancel:', 'PCX'],
  ['payment-gst:', 'GST'],
  ['payment-fee:', 'GWF'],
  ['payment:', 'PAY'],
  ['refund:', 'RFD'],
  ['charge:', 'CHG'],
  ['adjustment:', 'ADJ'],
  ['late-fee:', 'LATE'],
  ['advance-apply:', 'ADV'],
  ['account-cancel:', 'ACX'],
  ['finance-cancel:', 'FINX'],
  ['finance:', 'FIN'],
];
export const MAX_VOUCHER_NUMBER = 50;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Stable Tally REMOTEID / GUID of a journal: re-exports of the same journal carry the same id. */
export const remoteIdOf = (instituteId: number, journalKey: string) =>
  `erpc-${instituteId}-${sha256(journalKey).slice(0, 32)}`;

export interface ReceiptInfo {
  number: string;
  invoiceNumber: string | null;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Voucher number: the receipt number for a fee payment, the GST invoice number for its tax journal,
 * otherwise a prefix plus the journal's reference (`RFD-12-GST`, `CHG-40`, `FIN-7`).
 */
export function voucherNumber(journalKey: string, receipt: ReceiptInfo | undefined): string {
  let number: string | null = null;
  if (journalKey.startsWith('payment:')) number = receipt?.number ?? null;
  else if (journalKey.startsWith('payment-gst:')) number = receipt?.invoiceNumber ?? null;
  // eslint-disable-next-line no-control-regex
  number = number?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() || null;
  if (!number) {
    const hit = NUMBER_PREFIXES.find(([prefix]) => journalKey.startsWith(prefix));
    const rest = (hit ? journalKey.slice(hit[0].length) : journalKey).replace(/:writeoff$/, ':wo');
    number = [hit?.[1], ...rest.split(':')]
      .filter(Boolean)
      .join('-')
      .replace(/[^A-Za-z0-9/_.-]/g, '')
      .toUpperCase();
  }
  if (number.length <= MAX_VOUCHER_NUMBER) return number;
  return `${number.slice(0, MAX_VOUCHER_NUMBER - 9)}-${sha256(journalKey).slice(0, 8)}`;
}

/** Splits a GST payable amount into CGST / SGST / IGST in the receipt's proportions. */
export function splitGst(
  amount: number,
  receipt: ReceiptInfo | undefined,
): { account: string; amount: number }[] | null {
  if (!receipt) return null;
  const heads = GST_HEADS.filter((h) => receipt[h.key] > 0);
  const total = heads.reduce((s, h) => s + receipt[h.key], 0);
  if (!total) return null;
  let left = amount;
  return heads.map((h, i) => {
    const exact = (amount * receipt[h.key]) / total;
    // Round half away from zero so a reversal splits exactly like the original.
    const part = i === heads.length - 1 ? left : Math.sign(exact) * Math.round(Math.abs(exact));
    left -= part;
    return { account: h.account, amount: part };
  });
}

export interface BuildOptions {
  instituteId: number;
  receivableMode: TallyReceivableMode;
  gstLedgers: TallyGstLedgers;
  voucherTypes: TallyVoucherTypes;
  overrides: Overrides;
  lookups: MappingLookups;
  /** Tally ledger list of the export scope (decides cash/bank ledgers and which masters exist). */
  known: KnownList | null;
  /** Receipts by payment id (numbers and GST split). */
  receipts: Map<number, ReceiptInfo>;
  /** "Name (Admission no.)" by fee account id: party ledgers, and the student in narrations. */
  students: Map<number, string>;
}

export interface BuiltLine {
  ledger: string;
  group: string;
  gstDutyHead: string | null;
  /** Positive = debit, negative = credit (paise). */
  amount: number;
  cashOrBank: boolean;
  /** Student dues: the receivable control ledger or the student's party ledger. */
  receivable: boolean;
}

export interface BuiltVoucher {
  journalKey: string;
  entryDate: string;
  branchId: number | null;
  refType: string;
  refId: number | null;
  recordedAt: Date | null;
  typeKey: TallyVoucherTypeKey;
  voucherType: string;
  voucherNumber: string;
  remoteId: string;
  partyLedger: string | null;
  narration: string | null;
  /** Netted per Tally ledger, debits first. */
  lines: BuiltLine[];
  /** Sum of the debits (paise). */
  amount: number;
  /** Hash of the journal as posted in the app (changes if the entry itself changes). */
  fingerprint: string;
  /** Hash of the voucher as written for Tally (changes with the mapping or settings too). */
  contentDigest: string;
  /** Why the journal is not in the file (`null` = exported). */
  skipReason: string | null;
}

/** Turns journals into Tally vouchers for one export (one company, one set of settings). */
export class VoucherBuilder {
  /** Every (account, Tally ledger, group) used, for conflict checks. */
  private readonly used = new Map<string, { account: string; name: string; group: string }>();

  constructor(private readonly o: BuildOptions) {}

  private ledgerFor(account: string, j: JournalGroup) {
    const o = this.o;
    const party =
      o.receivableMode === 'party' && (account === L.RECEIVABLE || account === L.ADVANCE) && j.feeAccountId
        ? o.students.get(j.feeAccountId)
        : undefined;
    const source = party ? L.RECEIVABLE : account;
    const mapped = resolveAccount(source, j.branchId, o.overrides, o.lookups);
    const name = party ?? mapped.name;
    this.used.set(`${source}\n${name.toLowerCase()}\n${mapped.group.toLowerCase()}`, {
      account: source,
      name,
      group: mapped.group,
    });
    return {
      name,
      group: mapped.group,
      gstDutyHead: party ? null : mapped.gstDutyHead,
      receivable: source === L.RECEIVABLE,
    };
  }

  build(j: JournalGroup): BuiltVoucher {
    const o = this.o;
    const receipt = j.refType === 'payment' && j.refId ? o.receipts.get(j.refId) : undefined;
    const net = new Map<string, BuiltLine>();
    const add = (account: string, amount: number) => {
      if (!amount) return;
      const l = this.ledgerFor(account, j);
      const key = l.name.toLowerCase();
      const hit = net.get(key);
      if (hit) {
        hit.amount += amount;
        hit.receivable ||= l.receivable;
        return;
      }
      net.set(key, {
        ledger: l.name,
        group: l.group,
        gstDutyHead: l.gstDutyHead,
        amount,
        cashOrBank: isCashBankGroup(effectiveParent(l.name, l.group, o.known), o.known),
        receivable: l.receivable,
      });
    };
    let balance = 0;
    for (const r of j.rows) {
      const amount = r.debit - r.credit;
      balance += amount;
      const parts =
        r.account === L.GST_PAYABLE && o.gstLedgers === 'split' ? splitGst(amount, receipt) : null;
      if (parts) for (const p of parts) add(p.account, p.amount);
      else add(r.account, amount);
    }
    const nonZero = [...net.values()].filter((l) => l.amount !== 0);
    const lines = [...nonZero.filter((l) => l.amount > 0), ...nonZero.filter((l) => l.amount < 0)];

    let skipReason: string | null = null;
    if (balance !== 0 || !lines.every((l) => Number.isSafeInteger(l.amount)))
      skipReason = 'Journal does not balance';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(j.entryDate)) skipReason = 'Invalid date';
    else if (lines.length < 2) skipReason = 'Nets to zero in Tally';

    const typeKey = skipReason ? 'journal' : voucherTypeOf(j.key, lines);
    const debitLines = lines.filter((l) => l.amount > 0);
    const creditLines = lines.filter((l) => l.amount < 0);
    const largest = (ls: BuiltLine[]) =>
      ls.reduce<BuiltLine | null>(
        (best, l) => (!best || Math.abs(l.amount) > Math.abs(best.amount) ? l : best),
        null,
      )?.ledger ?? null;
    const partyLedger =
      typeKey === 'receipt'
        ? largest(creditLines.filter((l) => !l.cashOrBank))
        : typeKey === 'payment'
          ? largest(debitLines.filter((l) => !l.cashOrBank))
          : typeKey === 'feeCharge'
            ? largest(debitLines.filter((l) => l.receivable))
            : null;
    const voucherType = o.voucherTypes[typeKey];
    const number = voucherNumber(j.key, receipt);
    const student = j.feeAccountId ? o.students.get(j.feeAccountId) : undefined;
    const narration =
      `${[j.narration?.trim(), student ? `Student: ${student}` : null].filter(Boolean).join('; ')} [${j.key}]`
        .trim()
        .slice(0, 500);
    const amount = debitLines.reduce((s, l) => s + l.amount, 0);
    return {
      journalKey: j.key,
      entryDate: j.entryDate,
      branchId: j.branchId,
      refType: j.refType,
      refId: j.refId,
      recordedAt: j.recordedAt,
      typeKey,
      voucherType,
      voucherNumber: number,
      remoteId: remoteIdOf(o.instituteId, j.key),
      partyLedger,
      narration,
      lines: skipReason ? [] : lines,
      amount: skipReason ? 0 : amount,
      fingerprint: fingerprintOf(j),
      contentDigest: sha256(
        JSON.stringify([
          skipReason,
          voucherType.toLowerCase(),
          number,
          j.entryDate,
          partyLedger?.toLowerCase() ?? null,
          skipReason ? [] : lines.map((l) => [l.ledger.toLowerCase(), l.amount]),
        ]),
      ),
      skipReason,
    };
  }

  /** Tally ledger names used with more than one group so far. */
  conflicts(): TallyMappingConflictDto[] {
    return findConflicts([...this.used.values()]);
  }
}

/** Contra if every line is cash/bank, Receipt / Payment if cash/bank is only debited / credited. */
export function voucherTypeOf(
  journalKey: string,
  lines: Pick<BuiltLine, 'amount' | 'cashOrBank' | 'receivable'>[],
): TallyVoucherTypeKey {
  const cash = lines.filter((l) => l.cashOrBank);
  if (cash.length && cash.length === lines.length) return 'contra';
  if (cash.length) {
    const debited = cash.some((l) => l.amount > 0);
    const credited = cash.some((l) => l.amount < 0);
    if (debited && !credited) return 'receipt';
    if (credited && !debited) return 'payment';
    return 'journal';
  }
  if (
    FEE_CHARGE_PREFIXES.some((p) => journalKey.startsWith(p)) &&
    lines.some((l) => l.receivable && l.amount > 0)
  )
    return 'feeCharge';
  return 'journal';
}

export function fingerprintOf(j: JournalGroup): string {
  return sha256(
    JSON.stringify([
      j.key,
      j.entryDate,
      j.branchId,
      j.feeAccountId,
      j.refType,
      j.refId,
      j.rows.map((r) => [r.line, r.account, r.debit, r.credit]),
    ]),
  );
}

const exported = (vouchers: BuiltVoucher[]) => vouchers.filter((v) => !v.skipReason);

/** Ledger masters the exported vouchers use, except ledgers already in the imported Tally list. */
export function mastersFor(vouchers: BuiltVoucher[], known: KnownList | null): TallyMasterJson[] {
  const masters = new Map<string, TallyMasterJson>();
  for (const v of exported(vouchers))
    for (const l of v.lines) {
      const key = l.ledger.toLowerCase();
      if (masters.has(key) || known?.ledgers.has(key)) continue;
      masters.set(key, { name: l.ledger, parent: l.group, gstDutyHead: l.gstDutyHead });
    }
  return [...masters.values()].sort(
    (a, b) => a.parent.localeCompare(b.parent) || a.name.localeCompare(b.name),
  );
}

/** Debit / credit per Tally ledger over the exported vouchers. */
export function totalsFor(vouchers: BuiltVoucher[], known: KnownList | null): TallyTotalJson[] {
  const totals = new Map<string, TallyTotalJson>();
  for (const v of exported(vouchers))
    for (const l of v.lines) {
      const key = l.ledger.toLowerCase();
      let t = totals.get(key);
      if (!t) {
        t = { ledger: l.ledger, parent: effectiveParent(l.ledger, l.group, known), debit: 0, credit: 0 };
        totals.set(key, t);
      }
      if (l.amount > 0) t.debit += l.amount;
      else t.credit -= l.amount;
    }
  return [...totals.values()].sort((a, b) => a.ledger.localeCompare(b.ledger));
}

/** Vouchers per Tally voucher type name. */
export function typeCountsOf(vouchers: BuiltVoucher[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of exported(vouchers)) counts[v.voucherType] = (counts[v.voucherType] ?? 0) + 1;
  return counts;
}
