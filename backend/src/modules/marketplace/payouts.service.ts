import { Op, QueryTypes, type Transaction } from 'sequelize';
import {
  IFSC_PATTERN,
  UPI_ID_PATTERN,
  type MktPayoutAccountDto,
  type MktPayoutAccountInput,
  type MktPayoutAdminDto,
  type MktPayoutDetailDto,
  type MktPayoutDto,
  type MktPayoutLineDto,
  type MktPayoutPreviewDto,
  type MktPayoutPreviewRow,
  type MktPayoutRunDetailDto,
  type MktPayoutRunDto,
  type MktPayoutSettingsDto,
} from '@erp/shared';
import { decryptSecret, encryptSecret } from '../../infrastructure/crypto';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { audit } from '../../shared/audit/audit.service';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { MktCourse, MktMedia, MktOrder, MktSaleLedger, MktSeller } from './models';
import { MktPayout, MktPayoutAccount, MktPayoutRun, MktPayoutSettings } from './payouts.models';
import { notifyPayoutPaid } from './payouts.notify';
import { sellerRef } from './sellers.service';
import { iso } from './util';

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

// ---------------------------------------------------------------- dates (IST calendar)

/** Midnight IST of `YYYY-MM-DD`, as a Date. */
export function istDay(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

/** `YYYY-MM-DD` (IST) of a Date. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** First instant of the IST month containing `d`. */
export function istMonthStart(d: Date): Date {
  return istDay(`${istDate(d).slice(0, 7)}-01`);
}

/** "November 2026" for a payout period, by its (exclusive) end. */
export function periodLabel(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const last = new Date(end.getTime() - 1);
  return fmt(start) === fmt(last) ? fmt(start) : `${fmt(start)} – ${fmt(last)}`;
}

// ---------------------------------------------------------------- settings

export async function payoutSettings(transaction?: Transaction): Promise<MktPayoutSettings> {
  const row = await MktPayoutSettings.findOne({ order: [['id', 'ASC']], transaction });
  return (
    row ??
    MktPayoutSettings.create({ minPayoutPaise: 50_000, holdDays: 30, refundWindowDays: 30 }, { transaction })
  );
}

export const settingsDto = (s: MktPayoutSettings): MktPayoutSettingsDto => ({
  minPayoutPaise: s.minPayoutPaise,
  holdDays: s.holdDays,
  refundWindowDays: s.refundWindowDays,
});

export async function getPayoutSettings() {
  return settingsDto(await payoutSettings());
}

export async function updatePayoutSettings(input: Partial<MktPayoutSettingsDto>) {
  const s = await payoutSettings();
  await s.update(input);
  await audit({
    action: 'marketplace.payout_settings.updated',
    entityType: 'mkt_payout_settings',
    entityId: s.id,
    instituteId: null,
    metadata: input,
  });
  return settingsDto(s);
}

// ---------------------------------------------------------------- payout account

const digitsOnly = (v: string) => v.replace(/[\s-]/g, '');

export function maskAccount(method: 'bank' | 'upi', value: string): string {
  if (method === 'bank') return `XXXX${value.slice(-4)}`;
  const [name, domain] = value.split('@');
  return `${name.slice(0, 2)}••••@${domain}`;
}

interface AccountSecret {
  accountNumber?: string;
  upiId?: string;
}

export const toAccountDto = (a: MktPayoutAccount): MktPayoutAccountDto => ({
  method: a.method,
  holderName: a.holderName,
  bankName: a.bankName,
  ifsc: a.ifsc,
  maskedAccount: a.masked,
  updatedAt: iso(a.updatedAt)!,
});

function accountLabel(a: MktPayoutAccount) {
  return a.method === 'bank' ? `${a.bankName ?? 'Bank'} ${a.masked} (${a.ifsc})` : `UPI ${a.masked}`;
}

function readSecret(a: { accountEncrypted: string }): AccountSecret {
  return JSON.parse(decryptSecret(a.accountEncrypted)) as AccountSecret;
}

export async function getPayoutAccount(sellerId: number): Promise<MktPayoutAccountDto | null> {
  const a = await MktPayoutAccount.findOne({ where: { sellerId } });
  return a ? toAccountDto(a) : null;
}

export async function savePayoutAccount(sellerId: number, input: MktPayoutAccountInput) {
  let secret: AccountSecret;
  let masked: string;
  let ifsc: string | null = null;
  if (input.method === 'bank') {
    const number = digitsOnly(input.accountNumber ?? '');
    if (!/^\d{6,20}$/.test(number)) throw BadRequest('Enter a valid bank account number (6–20 digits)');
    ifsc = (input.ifsc ?? '').trim().toUpperCase();
    if (!IFSC_PATTERN.test(ifsc)) throw BadRequest('Enter a valid IFSC code, e.g. HDFC0001234');
    secret = { accountNumber: number };
    masked = maskAccount('bank', number);
  } else {
    const upi = (input.upiId ?? '').trim();
    if (!UPI_ID_PATTERN.test(upi)) throw BadRequest('Enter a valid UPI ID, e.g. name@okaxis');
    secret = { upiId: upi };
    masked = maskAccount('upi', upi);
  }
  const values = {
    sellerId,
    method: input.method,
    holderName: input.holderName.trim(),
    bankName: input.method === 'bank' ? input.bankName?.trim() || null : null,
    ifsc,
    accountEncrypted: encryptSecret(JSON.stringify(secret)),
    masked,
    updatedByUserId: getContext().userId ?? null,
  };
  const existing = await MktPayoutAccount.findOne({ where: { sellerId } });
  const saved = existing ? await existing.update(values) : await MktPayoutAccount.create(values);
  await audit({
    action: existing ? 'marketplace.payout_account.updated' : 'marketplace.payout_account.created',
    entityType: 'mkt_seller',
    entityId: sellerId,
    instituteId: null,
    metadata: { method: input.method, masked },
  });
  return toAccountDto(saved);
}

/** Full payout details for the admin paying the seller (audited). */
export async function revealPayoutAccount(payoutId: number) {
  const p = await MktPayout.findByPk(payoutId);
  if (!p) throw NotFound('Payout');
  const a = await MktPayoutAccount.findOne({ where: { sellerId: p.sellerId } });
  if (!a) throw NotFound('Payout details');
  await audit({
    action: 'marketplace.payout_account.revealed',
    entityType: 'mkt_payout',
    entityId: p.id,
    instituteId: null,
  });
  return { ...toAccountDto(a), ...readSecret(a) };
}

// ---------------------------------------------------------------- grouping unpaid ledger rows

interface SellerSum {
  sellerId: number;
  grossPaise: number;
  commissionPaise: number;
  refundsPaise: number;
  netPaise: number;
  entries: number;
  ids: number[];
}

/**
 * Unpaid ledger rows a run may pay: sales older than the hold window (refund window), refunded sales
 * of any age (they net out with their refund), and every unpaid refund (deducted as soon as possible,
 * even when the sale was paid out earlier).
 */
async function eligibleRows(eligibleBefore: Date, transaction?: Transaction) {
  return getSequelize().query<{
    id: number;
    seller_id: number;
    entry_type: 'sale' | 'refund';
    gross_paise: string;
    commission_paise: string;
    net_paise: string;
  }>(
    `SELECT l.id, l.seller_id, l.entry_type, l.gross_paise, l.commission_paise, l.net_paise
       FROM mkt_sale_ledger l
      WHERE l.payout_id IS NULL
        AND (l.entry_type = 'refund'
             OR l.created_at < :eligibleBefore
             OR EXISTS (SELECT 1 FROM mkt_sale_ledger r
                         WHERE r.entry_type = 'refund' AND r.order_item_id = l.order_item_id))
      ORDER BY l.id${transaction ? ' FOR UPDATE' : ''}`,
    { type: QueryTypes.SELECT, replacements: { eligibleBefore }, transaction },
  );
}

function groupBySeller(rows: Awaited<ReturnType<typeof eligibleRows>>): SellerSum[] {
  const by = new Map<number, SellerSum>();
  for (const r of rows) {
    const s =
      by.get(r.seller_id) ??
      ({
        sellerId: r.seller_id,
        grossPaise: 0,
        commissionPaise: 0,
        refundsPaise: 0,
        netPaise: 0,
        entries: 0,
        ids: [],
      } as SellerSum);
    const sign = r.entry_type === 'refund' ? -1 : 1;
    if (sign > 0) s.grossPaise += Number(r.gross_paise);
    else s.refundsPaise += Number(r.net_paise);
    s.commissionPaise += sign * Number(r.commission_paise);
    s.netPaise += sign * Number(r.net_paise);
    s.entries++;
    s.ids.push(r.id);
    by.set(r.seller_id, s);
  }
  return [...by.values()];
}

/** End of the period to pay: the end of last month (IST) unless given. */
function resolvePeriod(periodEnd?: string) {
  const end = periodEnd ? new Date(istDay(periodEnd).getTime() + DAY_MS) : istMonthStart(new Date());
  if (end.getTime() > Date.now() + DAY_MS) throw BadRequest('The payout period cannot end in the future');
  const start = istMonthStart(new Date(end.getTime() - 1));
  return { start, end };
}

async function computePreview(periodEnd: string | undefined, transaction?: Transaction) {
  const settings = await payoutSettings(transaction);
  const { start, end } = resolvePeriod(periodEnd);
  const holdCutoff = new Date(Date.now() - settings.holdDays * DAY_MS);
  const eligibleBefore = new Date(Math.min(end.getTime(), holdCutoff.getTime()));
  const sums = groupBySeller(await eligibleRows(eligibleBefore, transaction));
  const [sellers, accounts] = await Promise.all([
    MktSeller.findAll({
      where: { id: sums.map((s) => s.sellerId) },
      include: [{ model: MktMedia, as: 'avatar' }],
      transaction,
    }),
    MktPayoutAccount.findAll({ where: { sellerId: sums.map((s) => s.sellerId) }, transaction }),
  ]);
  const rows = sums
    .map((s) => ({
      ...s,
      seller: sellers.find((x) => x.id === s.sellerId)!,
      account: accounts.find((a) => a.sellerId === s.sellerId) ?? null,
      carriedForward: s.netPaise <= 0 || s.netPaise < settings.minPayoutPaise,
    }))
    .sort((a, b) => b.netPaise - a.netPaise);
  return { settings, start, end, eligibleBefore, rows };
}

export async function previewPayouts(periodEnd?: string): Promise<MktPayoutPreviewDto> {
  const p = await computePreview(periodEnd);
  const rows: MktPayoutPreviewRow[] = p.rows.map((r) => ({
    seller: sellerRef(r.seller),
    grossPaise: r.grossPaise,
    commissionPaise: r.commissionPaise,
    refundsPaise: r.refundsPaise,
    netPaise: r.netPaise,
    entries: r.entries,
    hasAccount: !!r.account,
    carriedForward: r.carriedForward,
  }));
  return {
    periodStart: iso(p.start)!,
    periodEnd: iso(p.end)!,
    eligibleBefore: iso(p.eligibleBefore)!,
    settings: settingsDto(p.settings),
    rows,
    totalNetPaise: rows.filter((r) => !r.carriedForward).reduce((t, r) => t + r.netPaise, 0),
  };
}

// ---------------------------------------------------------------- DTOs

function toPayoutDto(p: MktPayout, run: MktPayoutRun): MktPayoutDto {
  return {
    id: p.id,
    runId: p.runId,
    seller: sellerRef(p.seller!),
    periodStart: iso(run.periodStart)!,
    periodEnd: iso(run.periodEnd)!,
    status: p.status,
    grossPaise: p.grossPaise,
    commissionPaise: p.commissionPaise,
    refundsPaise: p.refundsPaise,
    netPaise: p.netPaise,
    entries: p.entries,
    reference: p.reference,
    paidTo: p.paidToMasked,
    holdReason: p.holdReason,
    paidAt: iso(p.paidAt),
    createdAt: iso(p.createdAt)!,
  };
}

function toRunDto(r: MktPayoutRun, payouts: MktPayout[]): MktPayoutRunDto {
  const live = payouts.filter((p) => p.status !== 'cancelled');
  const paid = live.filter((p) => p.status === 'paid');
  return {
    id: r.id,
    periodStart: iso(r.periodStart)!,
    periodEnd: iso(r.periodEnd)!,
    status: r.status,
    payouts: live.length,
    paid: paid.length,
    totalNetPaise: live.reduce((t, p) => t + p.netPaise, 0),
    paidNetPaise: paid.reduce((t, p) => t + p.netPaise, 0),
    createdAt: iso(r.createdAt)!,
    finalizedAt: iso(r.finalizedAt),
  };
}

const sellerInclude = { model: MktSeller, as: 'seller', include: [{ model: MktMedia, as: 'avatar' }] };

// ---------------------------------------------------------------- admin: runs

/**
 * Creates a payout run: one payout per seller owed at least the minimum, reserving the ledger rows
 * it covers (`payout_id`). Sellers without payout details are put on hold. One open run at a time.
 */
export async function createRun(periodEnd?: string): Promise<MktPayoutRunDetailDto> {
  const runId = await getSequelize().transaction(async (transaction) => {
    const open = await MktPayoutRun.findOne({
      where: { status: 'draft' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (open) throw Conflict(`Payout run #${open.id} is still open; finish or cancel it first`);
    const p = await computePreview(periodEnd, transaction);
    const payable = p.rows.filter((r) => !r.carriedForward);
    if (!payable.length) throw BadRequest('No seller is owed the minimum payout for this period');
    const run = await MktPayoutRun.create(
      {
        periodStart: p.start,
        periodEnd: p.end,
        eligibleBefore: p.eligibleBefore,
        createdByUserId: getContext().userId ?? null,
      },
      { transaction },
    );
    for (const r of payable) {
      const payout = await MktPayout.create(
        {
          runId: run.id,
          sellerId: r.sellerId,
          status: r.account ? 'pending' : 'held',
          holdReason: r.account ? null : 'No payout details',
          grossPaise: r.grossPaise,
          commissionPaise: r.commissionPaise,
          refundsPaise: r.refundsPaise,
          netPaise: r.netPaise,
          entries: r.entries,
        },
        { transaction },
      );
      await MktSaleLedger.update({ payoutId: payout.id }, { where: { id: r.ids }, transaction });
    }
    return run.id;
  });
  await audit({
    action: 'marketplace.payout_run.created',
    entityType: 'mkt_payout_run',
    entityId: runId,
    instituteId: null,
    metadata: { periodEnd: periodEnd ?? null },
  });
  return getRun(runId);
}

export async function listRuns(): Promise<MktPayoutRunDto[]> {
  const runs = await MktPayoutRun.findAll({
    include: [{ model: MktPayout, as: 'payouts', attributes: ['id', 'status', 'netPaise'] }],
    order: [['id', 'DESC']],
    limit: 100,
  });
  return runs.map((r) => toRunDto(r, r.payouts ?? []));
}

export async function getRun(id: number): Promise<MktPayoutRunDetailDto> {
  const run = await MktPayoutRun.findByPk(id);
  if (!run) throw NotFound('Payout run');
  const payouts = await MktPayout.findAll({
    where: { runId: id },
    include: [sellerInclude],
    order: [['netPaise', 'DESC']],
  });
  const accounts = await MktPayoutAccount.findAll({ where: { sellerId: payouts.map((p) => p.sellerId) } });
  return {
    ...toRunDto(run, payouts),
    items: payouts.map((p): MktPayoutAdminDto => {
      const a = accounts.find((x) => x.sellerId === p.sellerId);
      return { ...toPayoutDto(p, run), account: a ? toAccountDto(a) : null };
    }),
  };
}

async function lockedPayout(id: number, transaction: Transaction) {
  const p = await MktPayout.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!p) throw NotFound('Payout');
  const run = await MktPayoutRun.findByPk(p.runId, { transaction, lock: transaction.LOCK.UPDATE });
  if (run!.status !== 'draft') throw Conflict('This payout run is closed');
  return { p, run: run! };
}

/** Closes the run once every payout is paid or cancelled. */
async function settleRun(run: MktPayoutRun, transaction: Transaction) {
  const open = await MktPayout.count({ where: { runId: run.id, status: ['pending', 'held'] }, transaction });
  if (!open) await run.update({ status: 'finalized', finalizedAt: new Date() }, { transaction });
}

async function adminPayout(id: number): Promise<MktPayoutAdminDto> {
  const p = await MktPayout.findByPk(id, { include: [sellerInclude] });
  const run = await MktPayoutRun.findByPk(p!.runId);
  const a = await MktPayoutAccount.findOne({ where: { sellerId: p!.sellerId } });
  return { ...toPayoutDto(p!, run!), account: a ? toAccountDto(a) : null };
}

/** Records the bank transfer / UPI payment and notifies the seller. */
export async function markPaid(id: number, input: { reference: string; paidAt?: string | null }) {
  const reference = input.reference.trim();
  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  if (paidAt.getTime() > Date.now() + 5 * 60_000)
    throw BadRequest('The payment date cannot be in the future');
  const payout = await getSequelize().transaction(async (transaction) => {
    const { p, run } = await lockedPayout(id, transaction);
    if (p.status === 'paid') throw Conflict('This payout is already marked paid');
    if (p.status !== 'pending') throw Conflict('Release the payout from hold before paying it');
    const a = await MktPayoutAccount.findOne({ where: { sellerId: p.sellerId }, transaction });
    if (!a) throw BadRequest('The seller has no payout details yet');
    await p.update(
      {
        status: 'paid',
        reference,
        paidAt,
        paidByUserId: getContext().userId ?? null,
        paidToMasked: accountLabel(a),
        paidToEncrypted: encryptSecret(
          JSON.stringify({ ...readSecret(a), holderName: a.holderName, ifsc: a.ifsc, method: a.method }),
        ),
      },
      { transaction },
    );
    await settleRun(run, transaction);
    return { p, run };
  });
  await audit({
    action: 'marketplace.payout.paid',
    entityType: 'mkt_payout',
    entityId: id,
    instituteId: null,
    metadata: { reference, netPaise: payout.p.netPaise, sellerId: payout.p.sellerId },
  });
  const seller = await MktSeller.findByPk(payout.p.sellerId);
  if (seller)
    await notifyPayoutPaid(seller, {
      netPaise: payout.p.netPaise,
      period: periodLabel(payout.run.periodStart, payout.run.periodEnd),
      reference,
      paidTo: payout.p.paidToMasked ?? '',
    });
  return adminPayout(id);
}

export async function holdPayout(id: number, reason: string) {
  await getSequelize().transaction(async (transaction) => {
    const { p } = await lockedPayout(id, transaction);
    if (p.status !== 'pending') throw Conflict('Only a payout waiting to be paid can be put on hold');
    await p.update({ status: 'held', holdReason: reason.trim() }, { transaction });
  });
  await audit({
    action: 'marketplace.payout.held',
    entityType: 'mkt_payout',
    entityId: id,
    instituteId: null,
    metadata: { reason },
  });
  return adminPayout(id);
}

export async function releasePayout(id: number) {
  await getSequelize().transaction(async (transaction) => {
    const { p } = await lockedPayout(id, transaction);
    if (p.status !== 'held') throw Conflict('This payout is not on hold');
    if (!(await MktPayoutAccount.count({ where: { sellerId: p.sellerId }, transaction })))
      throw BadRequest('The seller has no payout details yet');
    await p.update({ status: 'pending', holdReason: null }, { transaction });
  });
  await audit({
    action: 'marketplace.payout.released',
    entityType: 'mkt_payout',
    entityId: id,
    instituteId: null,
  });
  return adminPayout(id);
}

/** Drops a seller from the run; its ledger rows go back to the unpaid pool for a later run. */
export async function cancelPayout(id: number, reason?: string | null) {
  await getSequelize().transaction(async (transaction) => {
    const { p, run } = await lockedPayout(id, transaction);
    if (p.status === 'paid' || p.status === 'cancelled') throw Conflict('This payout cannot be cancelled');
    await MktSaleLedger.update({ payoutId: null }, { where: { payoutId: p.id }, transaction });
    await p.update({ status: 'cancelled', holdReason: reason?.trim() || p.holdReason }, { transaction });
    await settleRun(run, transaction);
  });
  await audit({
    action: 'marketplace.payout.cancelled',
    entityType: 'mkt_payout',
    entityId: id,
    instituteId: null,
    metadata: { reason: reason ?? null },
  });
  return adminPayout(id);
}

/** Closes the run: unpaid payouts are cancelled and their rows carried forward. */
export async function finalizeRun(id: number) {
  await getSequelize().transaction(async (transaction) => {
    const run = await MktPayoutRun.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!run) throw NotFound('Payout run');
    if (run.status !== 'draft') throw Conflict('This payout run is closed');
    const open = await MktPayout.findAll({ where: { runId: id, status: ['pending', 'held'] }, transaction });
    for (const p of open) {
      await MktSaleLedger.update({ payoutId: null }, { where: { payoutId: p.id }, transaction });
      await p.update({ status: 'cancelled' }, { transaction });
    }
    await run.update({ status: 'finalized', finalizedAt: new Date() }, { transaction });
  });
  await audit({
    action: 'marketplace.payout_run.finalized',
    entityType: 'mkt_payout_run',
    entityId: id,
    instituteId: null,
  });
  return getRun(id);
}

/** Cancels a run nobody has been paid from yet; every row returns to the unpaid pool. */
export async function cancelRun(id: number) {
  await getSequelize().transaction(async (transaction) => {
    const run = await MktPayoutRun.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!run) throw NotFound('Payout run');
    if (run.status !== 'draft') throw Conflict('This payout run is closed');
    if (await MktPayout.count({ where: { runId: id, status: 'paid' }, transaction }))
      throw Conflict('Some sellers in this run are already paid; finalize it instead');
    const payouts = await MktPayout.findAll({ where: { runId: id }, attributes: ['id'], transaction });
    await MktSaleLedger.update(
      { payoutId: null },
      { where: { payoutId: payouts.map((p) => p.id) }, transaction },
    );
    await MktPayout.update({ status: 'cancelled' }, { where: { runId: id }, transaction });
    await run.update({ status: 'cancelled' }, { transaction });
  });
  await audit({
    action: 'marketplace.payout_run.cancelled',
    entityType: 'mkt_payout_run',
    entityId: id,
    instituteId: null,
  });
  return getRun(id);
}

// ---------------------------------------------------------------- CSV

const rupees = (paise: number) => (paise / 100).toFixed(2);

/** RFC 4180 field; a leading formula character is neutralised for spreadsheets. */
export function csvField(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csv = (rows: (string | number | null | undefined)[][]) =>
  rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';

/** Bank upload sheet for a run: full account details, so the export is audited. */
export async function exportRunCsv(id: number) {
  const run = await getRun(id);
  const payouts = await MktPayout.findAll({ where: { runId: id }, attributes: ['id', 'sellerId'] });
  const accounts = await MktPayoutAccount.findAll({ where: { sellerId: payouts.map((p) => p.sellerId) } });
  const rows: (string | number | null)[][] = [
    [
      'Payout ID',
      'Seller',
      'Seller type',
      'Status',
      'Method',
      'Account holder',
      'Bank',
      'Account number',
      'IFSC',
      'UPI ID',
      'Sales (₹)',
      'Commission (₹)',
      'Refunds (₹)',
      'Net payable (₹)',
      'Entries',
      'Reference (UTR)',
      'Paid at',
    ],
  ];
  for (const p of run.items) {
    const a = accounts.find((x) => x.sellerId === p.seller.id);
    const secret = a ? readSecret(a) : {};
    rows.push([
      p.id,
      p.seller.displayName,
      p.seller.type,
      p.status,
      a?.method ?? '',
      a?.holderName ?? '',
      a?.bankName ?? '',
      secret.accountNumber ?? '',
      a?.ifsc ?? '',
      secret.upiId ?? '',
      rupees(p.grossPaise),
      rupees(p.commissionPaise),
      rupees(p.refundsPaise),
      rupees(p.netPaise),
      p.entries,
      p.reference ?? '',
      p.paidAt ?? '',
    ]);
  }
  await audit({
    action: 'marketplace.payout_run.exported',
    entityType: 'mkt_payout_run',
    entityId: id,
    instituteId: null,
  });
  return {
    filename: `payout-run-${id}-${istDate(new Date(run.periodEnd)).slice(0, 7)}.csv`,
    body: csv(rows),
  };
}

// ---------------------------------------------------------------- seller: payouts & statements

export async function sellerPayouts(sellerId: number): Promise<MktPayoutDto[]> {
  const payouts = await MktPayout.findAll({
    where: { sellerId, status: { [Op.ne]: 'cancelled' } },
    include: [sellerInclude, { model: MktPayoutRun, as: 'run' }],
    order: [['id', 'DESC']],
    limit: 120,
  });
  return payouts.map((p) => toPayoutDto(p, p.run!));
}

async function payoutLines(payoutId: number): Promise<MktPayoutLineDto[]> {
  const rows = await MktSaleLedger.findAll({
    where: { payoutId },
    include: [
      { model: MktCourse, as: 'course', attributes: ['id', 'title'] },
      { model: MktOrder, as: 'order', attributes: ['id', 'number'] },
    ],
    order: [['id', 'ASC']],
  });
  return rows.map((r) => {
    const sign = r.entryType === 'refund' ? -1 : 1;
    return {
      id: r.id,
      entryType: r.entryType,
      orderNumber: r.order?.number ?? '',
      courseTitle: r.course?.title ?? '',
      grossPaise: sign * r.grossPaise,
      commissionPercent: r.commissionPercent,
      commissionPaise: sign * r.commissionPaise,
      netPaise: sign * r.netPaise,
      createdAt: iso(r.createdAt)!,
    };
  });
}

export async function sellerPayout(sellerId: number, id: number): Promise<MktPayoutDetailDto> {
  const p = await MktPayout.findOne({
    where: { id, sellerId },
    include: [sellerInclude, { model: MktPayoutRun, as: 'run' }],
  });
  if (!p) throw NotFound('Payout');
  return { ...toPayoutDto(p, p.run!), lines: await payoutLines(p.id) };
}

export async function sellerStatementCsv(sellerId: number, id: number) {
  const p = await sellerPayout(sellerId, id);
  const sum = (f: (l: MktPayoutLineDto) => number) => p.lines.reduce((t, l) => t + f(l), 0);
  const rows: (string | number | null)[][] = [
    ['Statement', `${p.seller.displayName} — ${periodLabel(new Date(p.periodStart), new Date(p.periodEnd))}`],
    ['Status', p.status],
    ['Reference (UTR)', p.reference ?? ''],
    ['Paid to', p.paidTo ?? ''],
    ['Paid at', p.paidAt ?? ''],
    [],
    [
      'Date',
      'Type',
      'Order',
      'Course',
      'Amount paid by buyer (₹)',
      'Commission %',
      'Commission (₹)',
      'Your earnings (₹)',
    ],
    ...p.lines.map((l) => [
      l.createdAt,
      l.entryType,
      l.orderNumber,
      l.courseTitle,
      rupees(l.grossPaise),
      l.commissionPercent,
      rupees(l.commissionPaise),
      rupees(l.netPaise),
    ]),
    [],
    [
      'Total',
      '',
      '',
      '',
      rupees(sum((l) => l.grossPaise)),
      '',
      rupees(sum((l) => l.commissionPaise)),
      rupees(sum((l) => l.netPaise)),
    ],
  ];
  return { filename: `marketplace-statement-${p.id}.csv`, body: csv(rows) };
}
