import { Op, QueryTypes, type Transaction, type WhereOptions } from 'sequelize';
import type {
  BilledPartyDto,
  BillingProfileDto,
  SaasCreditNoteDto,
  SaasInvoiceDto,
  SaasInvoiceKind,
  SaasInvoiceStatus,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { Institute } from '../institutes/institute.model';
import {
  SubscriptionAddon,
  SubscriptionCreditNote,
  SubscriptionInvoice,
  SubscriptionInvoiceLine,
  type InvoiceMeta,
} from './models';
import { getBillingPolicy, getBillingProfile } from './billing-settings';
import { addDaysIso, billingDate, financialYear, formatRupees, gstStateCode, isoDay } from './util';
import { renderPdf, type PdfLine, type PdfText } from './pdf';

/** Query options for platform (super admin / system) code: skips the tenant guard. */
export const platform = <T extends object>(opts: T): T => ({ ...opts, tenantBypass: true }) as T;

type Seller = SubscriptionInvoice['seller'];

// ------------------------------------------------------------------ numbering

const ensuredSequences = new Set<string>();

/** Creates the counter row outside any transaction (once per process) so first uses don't deadlock. */
async function ensureSequence(kind: string, scopeKey: string): Promise<void> {
  const key = `${kind}|${scopeKey}`;
  if (ensuredSequences.has(key)) return;
  await getSequelize().query(
    `INSERT IGNORE INTO subscription_sequences (kind, scope_key, \`last_value\`, created_at, updated_at)
     VALUES (:kind, :scopeKey, 0, NOW(), NOW())`,
    { replacements: { kind, scopeKey }, type: QueryTypes.INSERT },
  );
  ensuredSequences.add(key);
}

const scopeFor = (prefix: string, issueDate: string) => `${prefix}/${financialYear(issueDate)}`;

/**
 * Next gap-free document number `<prefix>/<FY>/<000001>` (Indian financial year). The UPDATE row
 * lock is held until the caller's transaction commits, serialising concurrent allocations.
 */
async function allocateNumber(
  kind: 'invoice' | 'credit_note',
  prefix: string,
  issueDate: string,
  transaction: Transaction,
): Promise<string> {
  const scopeKey = scopeFor(prefix, issueDate);
  const sequelize = getSequelize();
  const replacements = { kind, scopeKey };
  await sequelize.query(
    `UPDATE subscription_sequences SET \`last_value\` = \`last_value\` + 1, updated_at = NOW()
     WHERE kind = :kind AND scope_key = :scopeKey`,
    { replacements, transaction, type: QueryTypes.UPDATE },
  );
  const rows = await sequelize.query<{ last_value: number }>(
    'SELECT `last_value` FROM subscription_sequences WHERE kind = :kind AND scope_key = :scopeKey',
    { replacements, transaction, type: QueryTypes.SELECT },
  );
  if (!rows.length) throw new Error(`Subscription sequence ${kind}/${scopeKey} missing`);
  return `${scopeKey}/${String(rows[0].last_value).padStart(6, '0')}`;
}

// ------------------------------------------------------------------ GST

export interface GstSplit {
  rateBp: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Supply within one state → CGST + SGST (half each); otherwise IGST. When either party's state is
 * unknown the supplier's location is the place of supply (intra-state).
 */
export function isIntraState(seller: BilledPartyDto, buyer: BilledPartyDto): boolean {
  const a = gstStateCode(seller);
  const b = gstStateCode(buyer);
  return !a || !b || a === b;
}

export function gstFor(taxable: number, ratePercent: number, seller: BilledPartyDto, buyer: BilledPartyDto) {
  const rateBp = Math.max(0, Math.round(ratePercent * 100));
  const tax = Math.round((taxable * rateBp) / 10000);
  if (isIntraState(seller, buyer)) {
    const cgst = Math.floor(tax / 2);
    return { rateBp, cgst, sgst: tax - cgst, igst: 0 };
  }
  return { rateBp, cgst: 0, sgst: 0, igst: tax };
}

export const billedParty = (i: Institute): BilledPartyDto => ({
  name: i.name,
  gstin: i.gstin ?? null,
  address: i.address ?? null,
  city: i.city ?? null,
  state: i.state ?? null,
});

export const sellerParty = (p: BillingProfileDto): Seller => ({
  name: p.legalName,
  gstin: p.gstin,
  address: p.address,
  city: [p.city, p.pincode].filter(Boolean).join(' - ') || null,
  state: p.state,
  email: p.email,
  phone: p.phone,
});

// ------------------------------------------------------------------ invoices

export interface InvoiceLineInput {
  description: string;
  quantity?: number;
  unitPricePaise: number;
  /** Defaults to quantity × unit price (set for prorated lines). */
  amountPaise?: number;
  itemType?: string | null;
}

export interface CreateInvoiceInput {
  instituteId: number;
  subscriptionId: number | null;
  kind: SaasInvoiceKind;
  lines: InvoiceLineInput[];
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /** `YYYY-MM-DD`; defaults to issue date + the policy's due days. */
  dueDate?: string;
  meta?: InvoiceMeta | null;
  notes?: string | null;
  createdBy?: number | null;
  now?: Date;
}

/** Issues a GST invoice to an institute with the operator's current billing profile. */
export async function createInvoice(
  input: CreateInvoiceInput,
  transaction?: Transaction,
): Promise<SubscriptionInvoice> {
  const now = input.now ?? new Date();
  const [profile, policy, institute] = await Promise.all([
    getBillingProfile(),
    getBillingPolicy(),
    Institute.findByPk(input.instituteId, { transaction }),
  ]);
  if (!institute) throw NotFound('Institute');
  const lines = input.lines
    .map((l) => {
      const quantity = Math.max(1, Math.round(l.quantity ?? 1));
      const unitPricePaise = Math.max(0, Math.round(l.unitPricePaise));
      return {
        description: l.description.slice(0, 255),
        sacCode: profile.sacCode || null,
        itemType: l.itemType ?? null,
        quantity,
        unitPricePaise,
        amountPaise: Math.max(0, Math.round(l.amountPaise ?? quantity * unitPricePaise)),
      };
    })
    .filter((l) => l.amountPaise > 0);
  const subtotal = lines.reduce((s, l) => s + l.amountPaise, 0);
  if (subtotal <= 0) throw BadRequest('Nothing to invoice');
  const billedTo = billedParty(institute);
  const seller = sellerParty(profile);
  const gst = gstFor(subtotal, profile.gstRatePercent, seller, billedTo);
  const issueDate = billingDate(now);
  const dueDate =
    input.dueDate && input.dueDate > issueDate ? input.dueDate : addDaysIso(issueDate, policy.invoiceDueDays);
  await ensureSequence('invoice', scopeFor(profile.invoicePrefix, issueDate));
  const run = async (tx: Transaction) => {
    const number = await allocateNumber('invoice', profile.invoicePrefix, issueDate, tx);
    const inv = await SubscriptionInvoice.create(
      {
        instituteId: input.instituteId,
        subscriptionId: input.subscriptionId,
        number,
        kind: input.kind,
        issueDate,
        dueDate,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        subtotalPaise: subtotal,
        gstRateBp: gst.rateBp,
        cgstPaise: gst.cgst,
        sgstPaise: gst.sgst,
        igstPaise: gst.igst,
        totalPaise: subtotal + gst.cgst + gst.sgst + gst.igst,
        billedTo,
        seller,
        meta: input.meta ?? null,
        notes: input.notes ?? null,
        createdBy: input.createdBy ?? null,
      },
      { transaction: tx },
    );
    inv.lines = await SubscriptionInvoiceLine.bulkCreate(
      lines.map((l) => ({ ...l, invoiceId: inv.id })),
      { transaction: tx },
    );
    return inv;
  };
  return transaction ? run(transaction) : getSequelize().transaction(run);
}

export const invoiceBalance = (inv: SubscriptionInvoice) =>
  inv.totalPaise - inv.creditedPaise - inv.paidPaise;

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toInvoiceDto(inv: SubscriptionInvoice): SaasInvoiceDto {
  return {
    id: inv.id,
    number: inv.number,
    instituteId: inv.instituteId,
    instituteName: inv.billedTo?.name ?? '',
    kind: inv.kind,
    status: inv.status,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    periodStart: iso(inv.periodStart),
    periodEnd: iso(inv.periodEnd),
    subtotalPaise: inv.subtotalPaise,
    cgstPaise: inv.cgstPaise,
    sgstPaise: inv.sgstPaise,
    igstPaise: inv.igstPaise,
    totalPaise: inv.totalPaise,
    creditedPaise: inv.creditedPaise,
    paidPaise: inv.paidPaise,
    balancePaise: invoiceBalance(inv),
    billedTo: inv.billedTo,
    seller: inv.seller,
    lines: inv.lines?.map((l) => ({
      id: l.id,
      description: l.description,
      sacCode: l.sacCode,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
      amountPaise: l.amountPaise,
    })),
    notes: inv.notes,
    paidAt: iso(inv.paidAt),
    voidedAt: iso(inv.voidedAt),
    voidReason: inv.voidReason,
    createdAt: inv.createdAt.toISOString(),
  };
}

/** Invoice of the institute (tenant routes) or any invoice (`instituteId` null: platform). */
export async function findInvoice(
  id: number,
  instituteId: number | null,
  opts: { transaction?: Transaction; lock?: boolean } = {},
): Promise<SubscriptionInvoice> {
  const lock = opts.lock && opts.transaction ? opts.transaction.LOCK.UPDATE : undefined;
  const inv =
    instituteId === null
      ? await SubscriptionInvoice.findOne(platform({ where: { id }, transaction: opts.transaction, lock }))
      : await SubscriptionInvoice.findOne({
          where: { instituteId, id },
          transaction: opts.transaction,
          lock,
        });
  if (!inv) throw NotFound('Invoice');
  inv.lines = await SubscriptionInvoiceLine.findAll({
    where: { invoiceId: inv.id },
    order: [['id', 'ASC']],
    transaction: opts.transaction,
  });
  return inv;
}

export interface InvoiceListQuery {
  instituteId?: number;
  status?: SaasInvoiceStatus;
  kind?: SaasInvoiceKind;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listInvoices(q: InvoiceListQuery, tenantScoped: boolean) {
  const where: WhereOptions = {};
  if (q.instituteId) Object.assign(where, { instituteId: q.instituteId });
  if (q.status) Object.assign(where, { status: q.status });
  if (q.kind) Object.assign(where, { kind: q.kind });
  if (q.search) Object.assign(where, { number: { [Op.like]: `%${q.search}%` } });
  const opts = {
    where,
    order: [['id', 'DESC']] as [string, string][],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  };
  const { rows, count } = await SubscriptionInvoice.findAndCountAll(tenantScoped ? opts : platform(opts));
  return { items: rows.map(toInvoiceDto), total: count, page: q.page, pageSize: q.pageSize };
}

/** Voids an unpaid invoice; pending add-ons it would have activated are cancelled. */
export async function voidInvoice(id: number, reason: string, transaction: Transaction) {
  const inv = await findInvoice(id, null, { transaction, lock: true });
  if (inv.status !== 'open') throw Conflict('Only open invoices can be voided', 'INVOICE_NOT_OPEN');
  if (inv.paidPaise > 0 || inv.creditedPaise > 0)
    throw Conflict(
      'The invoice has payments or credit notes; issue a credit note for the balance instead',
      'INVOICE_HAS_PAYMENTS',
    );
  await inv.update({ status: 'void', voidedAt: new Date(), voidReason: reason }, { transaction });
  if (inv.instituteId)
    await SubscriptionAddon.update(
      { status: 'cancelled' },
      { where: { instituteId: inv.instituteId, invoiceId: inv.id, status: 'pending' }, transaction },
    );
  return inv;
}

/**
 * Credit note against an invoice (amount includes GST, split like the invoice). Reduces what the
 * institute owes; an open invoice that is fully settled by credit counts as paid. Credit beyond
 * the unpaid balance of a paid invoice is a refund due to the institute (settled offline).
 */
export async function createCreditNote(
  invoiceId: number,
  amountPaise: number,
  reason: string,
  userId: number | null,
  transaction: Transaction,
): Promise<{ note: SubscriptionCreditNote; invoice: SubscriptionInvoice; settled: boolean }> {
  const inv = await findInvoice(invoiceId, null, { transaction, lock: true });
  if (inv.status === 'void') throw Conflict('The invoice is void', 'INVOICE_VOID');
  const creditable = inv.totalPaise - inv.creditedPaise;
  if (amountPaise <= 0 || amountPaise > creditable)
    throw BadRequest(`Credit must be between 0.01 and ${formatRupees(creditable)}`);
  const profile = await getBillingProfile();
  const taxable = inv.totalPaise
    ? Math.round((amountPaise * inv.subtotalPaise) / inv.totalPaise)
    : amountPaise;
  const tax = amountPaise - taxable;
  const intra = inv.igstPaise === 0;
  const cgst = intra ? Math.floor(tax / 2) : 0;
  const issueDate = billingDate();
  await ensureSequence('credit_note', scopeFor(profile.creditNotePrefix, issueDate));
  const number = await allocateNumber('credit_note', profile.creditNotePrefix, issueDate, transaction);
  const note = await SubscriptionCreditNote.create(
    {
      instituteId: inv.instituteId,
      invoiceId: inv.id,
      number,
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: intra ? tax - cgst : 0,
      igstPaise: intra ? 0 : tax,
      amountPaise,
      reason,
      billedTo: inv.billedTo,
      seller: inv.seller,
      createdBy: userId,
    },
    { transaction },
  );
  const settled =
    inv.status === 'open' && inv.totalPaise - (inv.creditedPaise + amountPaise) - inv.paidPaise <= 0;
  await inv.update(
    {
      creditedPaise: inv.creditedPaise + amountPaise,
      meta: { ...(inv.meta ?? {}), creditNotes: [...(inv.meta?.creditNotes ?? []), number] },
      ...(settled ? { status: 'paid' as const, paidAt: new Date() } : {}),
    },
    { transaction },
  );
  return { note, invoice: inv, settled };
}

export function toCreditNoteDto(n: SubscriptionCreditNote, invoiceNumber: string): SaasCreditNoteDto {
  return {
    id: n.id,
    number: n.number,
    instituteId: n.instituteId,
    instituteName: n.billedTo?.name ?? '',
    invoiceId: n.invoiceId,
    invoiceNumber,
    amountPaise: n.amountPaise,
    taxablePaise: n.taxablePaise,
    taxPaise: n.cgstPaise + n.sgstPaise + n.igstPaise,
    reason: n.reason,
    createdAt: n.createdAt.toISOString(),
  };
}

export async function listCreditNotes(
  q: { instituteId?: number; page: number; pageSize: number },
  tenantScoped: boolean,
) {
  const opts = {
    where: q.instituteId ? { instituteId: q.instituteId } : {},
    include: [{ model: SubscriptionInvoice, as: 'invoice', attributes: ['id', 'number'] }],
    order: [['id', 'DESC']] as [string, string][],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  };
  const { rows, count } = await SubscriptionCreditNote.findAndCountAll(tenantScoped ? opts : platform(opts));
  return {
    items: rows.map((n) => toCreditNoteDto(n, n.invoice?.number ?? '')),
    total: count,
    page: q.page,
    pageSize: q.pageSize,
  };
}

// ------------------------------------------------------------------ PDF

const inr = (p: number) => `Rs. ${formatRupees(p)}`;

function partyLines(p: BilledPartyDto): string[] {
  return [
    p.address,
    [p.city, p.state].filter(Boolean).join(', ') || null,
    p.gstin ? `GSTIN: ${p.gstin}` : null,
  ].filter((s): s is string => !!s);
}

interface DocRow {
  description: string;
  sac: string | null;
  qty: number;
  unit: number;
  amount: number;
}

function renderDocument(doc: {
  title: string;
  stamp: string | null;
  info: [string, string][];
  seller: Seller;
  billedTo: BilledPartyDto;
  rows: DocRow[];
  totals: [string, number, boolean?][];
  footer: string[];
}): Buffer {
  const t: PdfText[] = [];
  const l: PdfLine[] = [];
  t.push({ x: 50, y: 50, text: doc.seller.name, size: 15, bold: true });
  let y = 66;
  for (const s of [
    ...partyLines(doc.seller),
    [doc.seller.email, doc.seller.phone].filter(Boolean).join(' | '),
  ].filter(Boolean)) {
    t.push({ x: 50, y, text: s, size: 9 });
    y += 12;
  }
  t.push({ x: 545, y: 50, text: doc.title, size: 13, bold: true, align: 'right' });
  if (doc.stamp) t.push({ x: 545, y: 68, text: doc.stamp, size: 12, bold: true, align: 'right' });
  y = Math.max(y, 90) + 6;
  l.push({ x1: 50, y1: y, x2: 545, y2: y });
  y += 18;
  const top = y;
  t.push({ x: 50, y, text: 'Billed to', bold: true, size: 9 });
  y += 14;
  t.push({ x: 50, y, text: doc.billedTo.name, bold: true });
  y += 13;
  for (const s of partyLines(doc.billedTo)) {
    t.push({ x: 50, y, text: s, size: 9 });
    y += 12;
  }
  let iy = top;
  for (const [k, v] of doc.info) {
    t.push(
      { x: 330, y: iy, text: k, size: 9, bold: true },
      { x: 545, y: iy, text: v, size: 9, align: 'right' },
    );
    iy += 14;
  }
  y = Math.max(y, iy) + 14;
  l.push({ x1: 50, y1: y, x2: 545, y2: y });
  y += 14;
  t.push(
    { x: 50, y, text: 'Description', bold: true, size: 9 },
    { x: 330, y, text: 'SAC', bold: true, size: 9 },
    { x: 400, y, text: 'Qty', bold: true, size: 9, align: 'right' },
    { x: 470, y, text: 'Rate', bold: true, size: 9, align: 'right' },
    { x: 545, y, text: 'Amount', bold: true, size: 9, align: 'right' },
  );
  y += 6;
  l.push({ x1: 50, y1: y, x2: 545, y2: y });
  y += 14;
  for (const r of doc.rows) {
    t.push(
      { x: 50, y, text: r.description.slice(0, 60), size: 9 },
      { x: 330, y, text: r.sac ?? '', size: 9 },
      { x: 400, y, text: String(r.qty), size: 9, align: 'right' },
      { x: 470, y, text: formatRupees(r.unit), size: 9, align: 'right' },
      { x: 545, y, text: formatRupees(r.amount), size: 9, align: 'right' },
    );
    y += 14;
  }
  l.push({ x1: 50, y1: y - 6, x2: 545, y2: y - 6 });
  y += 8;
  for (const [k, v, bold] of doc.totals) {
    t.push(
      { x: 400, y, text: k, size: bold ? 11 : 9, bold: !!bold },
      { x: 545, y, text: inr(v), size: bold ? 11 : 9, bold: !!bold, align: 'right' },
    );
    y += bold ? 18 : 14;
  }
  y += 10;
  for (const s of doc.footer) {
    t.push({ x: 50, y, text: s, size: 8 });
    y += 11;
  }
  t.push({
    x: 50,
    y: 800,
    text: 'This is a computer-generated document and does not require a signature.',
    size: 8,
  });
  return renderPdf(t, l);
}

const gstRows = (r: { gstRateBp: number; cgst: number; sgst: number; igst: number }): [string, number][] => {
  const pct = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  const rows: [string, number][] = [];
  if (r.igst) rows.push([`IGST @ ${pct(r.gstRateBp)}`, r.igst]);
  if (r.cgst) rows.push([`CGST @ ${pct(r.gstRateBp / 2)}`, r.cgst]);
  if (r.sgst) rows.push([`SGST @ ${pct(r.gstRateBp / 2)}`, r.sgst]);
  return rows;
};

const KIND_LABEL: Record<SaasInvoiceKind, string> = {
  subscription: 'Subscription',
  renewal: 'Renewal',
  upgrade: 'Plan change',
  addon: 'Add-on',
  overage: 'Usage overage',
  manual: 'Adjustment',
};

export function invoicePdf(inv: SubscriptionInvoice): Buffer {
  const tax = inv.cgstPaise + inv.sgstPaise + inv.igstPaise;
  const info: [string, string][] = [
    ['Invoice no.', inv.number],
    ['Invoice date', inv.issueDate],
    ['Due date', inv.dueDate],
    ['Type', KIND_LABEL[inv.kind] ?? inv.kind],
  ];
  if (inv.periodStart && inv.periodEnd)
    info.push(['Service period', `${isoDay(inv.periodStart)} to ${isoDay(inv.periodEnd)}`]);
  const totals: [string, number, boolean?][] = [
    ['Taxable value', inv.subtotalPaise],
    ...gstRows({ gstRateBp: inv.gstRateBp, cgst: inv.cgstPaise, sgst: inv.sgstPaise, igst: inv.igstPaise }),
    ['Total', inv.totalPaise, true],
  ];
  if (inv.creditedPaise) totals.push(['Credit notes', inv.creditedPaise]);
  if (inv.paidPaise) totals.push(['Paid', inv.paidPaise]);
  if (inv.status === 'open') totals.push(['Balance due', Math.max(0, invoiceBalance(inv)), true]);
  return renderDocument({
    title: tax || inv.seller.gstin ? 'TAX INVOICE' : 'INVOICE',
    stamp: inv.status === 'paid' ? 'PAID' : inv.status === 'void' ? 'VOID' : null,
    info,
    seller: inv.seller,
    billedTo: inv.billedTo,
    rows: (inv.lines ?? []).map((l) => ({
      description: l.description,
      sac: l.sacCode,
      qty: l.quantity,
      unit: l.unitPricePaise,
      amount: l.amountPaise,
    })),
    totals,
    footer: [
      ...(inv.meta?.creditNotes?.length ? [`Credit notes: ${inv.meta.creditNotes.join(', ')}`] : []),
      ...(inv.voidReason ? [`Voided: ${inv.voidReason}`] : []),
      ...(inv.notes ? [inv.notes] : []),
    ],
  });
}

export function creditNotePdf(note: SubscriptionCreditNote, invoice: SubscriptionInvoice): Buffer {
  const gstRateBp = invoice.gstRateBp;
  return renderDocument({
    title: 'CREDIT NOTE',
    stamp: null,
    info: [
      ['Credit note no.', note.number],
      ['Date', billingDate(note.createdAt)],
      ['Against invoice', invoice.number],
      ['Invoice date', invoice.issueDate],
    ],
    seller: note.seller,
    billedTo: note.billedTo,
    rows: [
      {
        description: `Credit: ${note.reason}`,
        sac: invoice.lines?.[0]?.sacCode ?? null,
        qty: 1,
        unit: note.taxablePaise,
        amount: note.taxablePaise,
      },
    ],
    totals: [
      ['Taxable value', note.taxablePaise],
      ...gstRows({ gstRateBp, cgst: note.cgstPaise, sgst: note.sgstPaise, igst: note.igstPaise }),
      ['Total credit', note.amountPaise, true],
    ],
    footer: [],
  });
}
