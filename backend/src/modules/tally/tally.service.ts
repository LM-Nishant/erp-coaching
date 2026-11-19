import { promises as fs } from 'node:fs';
import { Op, UniqueConstraintError, type Transaction, type WhereOptions } from 'sequelize';
import {
  LEDGER_ACCOUNTS as L,
  TALLY_DEFAULT_VOUCHER_TYPES,
  TALLY_LIMITS,
  TALLY_RECON_FLAGS,
  TALLY_VOUCHER_TYPE_KEYS,
  type TallyExportDetailDto,
  type TallyExportDto,
  type TallyExportRequest,
  type TallyKnownLedgerDto,
  type TallyKnownLedgersDto,
  type TallyKnownLedgersInfo,
  type TallyLedgerImportResult,
  type TallyLedgerTotal,
  type TallyMappingDto,
  type TallyMappingItemDto,
  type TallyMappingUpdate,
  type TallyMasterDto,
  type TallyPreviewDto,
  type TallyReceivableMode,
  type TallyReconFlag,
  type TallyReconItemDto,
  type TallyReconTotalDto,
  type TallyReconciliationDto,
  type TallySettingsDto,
  type TallySettingsEffective,
  type TallySettingsUpdate,
  type TallySettingsValues,
  type TallyVoucherTypes,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { requireTenantContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { Branch } from '../branches/branch.model';
import { User } from '../users/user.model';
import { Student } from '../students/api';
import { BankAccount, FeeAccount, FeeLedgerEntry, FeeReceipt, FinanceCategory } from '../fees/models';
import { auditFee, daysBetween } from '../fees/util';
import { decodeTallyFile, parseTallyLedgerList } from './ledger-list';
import {
  STANDARD_ACCOUNTS,
  accountDef,
  cleanName,
  effectiveParent,
  findConflicts,
  isCashBankGroup,
  knownGroup,
  partyLedgerName,
  resolveAccount,
  type KnownList,
  type MappingLookups,
  type Overrides,
} from './mapping';
import {
  TallyExport,
  TallyExportVoucher,
  TallyKnownLedger,
  TallyLedgerMapping,
  TallySettingsRow,
  type TallyMasterJson,
  type TallyTotalJson,
  type TallyVoucherStatus,
} from './models';
import {
  VoucherBuilder,
  groupJournals,
  isReversal,
  mastersFor,
  totalsFor,
  typeCountsOf,
  type BuiltVoucher,
  type JournalGroup,
  type LedgerRow,
  type ReceiptInfo,
} from './vouchers';
import { mastersXml, tallyDate, vouchersXml, assertBalanced, type XmlLedger, type XmlVoucher } from './xml';

/** Exports are listed per branch; all-branch exports (`branchId` NULL) only for institute-level users. */
export const exportRepo = new TenantRepository(TallyExport, { branchScoped: true, entity: 'Tally export' });

const CHUNK = 1000;
const RECON_ITEM_LIMIT = 500;
const LIST_LIMIT = 1000;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const unique = <T>(items: T[]) => [...new Set(items)];
const scopeOf = (branchId: number | null) => branchId ?? 0;
const companyKey = (company: string | null | undefined) => company?.trim().toLowerCase() || null;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** DATEONLY as `YYYY-MM-DD` whatever the driver returns. */
function dateStr(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? '').slice(0, 10);
}

// ------------------------------------------------------------------ scope

/**
 * Branch scope of a request. `undefined`: the selected branch (X-Branch-Id), else the user's only
 * branch, else institute-wide for institute-level users. `null`: institute-wide / all branches,
 * institute-level users only. A number: that branch, if the user may see it.
 */
export async function resolveScope(requested: number | null | undefined): Promise<number | null> {
  const ctx = requireTenantContext();
  const allowed = ctx.allowedBranchIds;
  const active = ctx.activeBranchId ?? null;
  if (requested === undefined) {
    if (active) return active;
    if (allowed === null) return null;
    if (allowed.length === 1) return allowed[0];
    throw new AppError(400, 'BRANCH_REQUIRED', 'Select a branch');
  }
  if (requested === null) {
    if (allowed !== null || active)
      throw Forbidden('Only institute-level users can work with all branches', 'BRANCH_FORBIDDEN');
    return null;
  }
  const branch = await Branch.findOne({
    where: { id: requested, instituteId: ctx.instituteId },
    attributes: ['id'],
  });
  if (!branch) throw NotFound('Branch');
  if ((allowed !== null && !allowed.includes(requested)) || (active && active !== requested))
    throw Forbidden('You do not have access to this branch', 'BRANCH_FORBIDDEN');
  return requested;
}

// ------------------------------------------------------------------ settings

const DEFAULT_SETTINGS: TallySettingsEffective = {
  companyName: null,
  receivableMode: 'control',
  gstLedgers: 'split',
  voucherTypes: { ...TALLY_DEFAULT_VOUCHER_TYPES },
};

export const MAX_COMPANY_NAME = 150;
export const MAX_VOUCHER_TYPE_NAME = 50;

function voucherTypesOf(value: unknown): Partial<TallyVoucherTypes> | null {
  const v = parseJson(value);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Partial<TallyVoucherTypes> = {};
  for (const key of TALLY_VOUCHER_TYPE_KEYS) {
    const raw = (v as Record<string, unknown>)[key];
    const name = typeof raw === 'string' ? cleanName(raw, MAX_VOUCHER_TYPE_NAME) : '';
    if (name) out[key] = name;
  }
  return Object.keys(out).length ? out : null;
}

function rowValues(row: TallySettingsRow | null): TallySettingsValues {
  const mode = row?.receivableMode;
  const gst = row?.gstLedgers;
  return {
    companyName: (row?.companyName && cleanName(row.companyName, MAX_COMPANY_NAME)) || null,
    receivableMode: mode === 'control' || mode === 'party' ? mode : null,
    gstLedgers: gst === 'split' || gst === 'single' ? gst : null,
    voucherTypes: voucherTypesOf(row?.voucherTypes),
  };
}

function mergeSettings(base: TallySettingsEffective, v: TallySettingsValues): TallySettingsEffective {
  return {
    companyName: v.companyName ?? base.companyName,
    receivableMode: v.receivableMode ?? base.receivableMode,
    gstLedgers: v.gstLedgers ?? base.gstLedgers,
    voucherTypes: { ...base.voucherTypes, ...(v.voucherTypes ?? {}) },
  };
}

async function settingsFor(instituteId: number, branchId: number | null): Promise<TallySettingsDto> {
  const rows = await TallySettingsRow.findAll({
    where: { instituteId, branchScope: unique([0, scopeOf(branchId)]) },
  });
  const inst = rows.find((r) => r.branchScope === 0) ?? null;
  const own = branchId ? (rows.find((r) => r.branchScope === branchId) ?? null) : inst;
  const inherited = branchId ? mergeSettings(DEFAULT_SETTINGS, rowValues(inst)) : DEFAULT_SETTINGS;
  const values = rowValues(own);
  return {
    branchId,
    values,
    effective: mergeSettings(inherited, values),
    inherited,
    updatedAt: iso(own?.updatedAt),
  };
}

export async function getSettings(requested: number | null | undefined): Promise<TallySettingsDto> {
  const branchId = await resolveScope(requested);
  return settingsFor(requireTenantContext().instituteId, branchId);
}

export async function updateSettings(input: TallySettingsUpdate): Promise<TallySettingsDto> {
  const branchId = await resolveScope(input.branchId);
  const { instituteId, userId } = requireTenantContext();
  const before = await settingsFor(instituteId, branchId);
  const values = {
    companyName: (input.companyName && cleanName(input.companyName, MAX_COMPANY_NAME)) || null,
    receivableMode: input.receivableMode ?? null,
    gstLedgers: input.gstLedgers ?? null,
    voucherTypes: voucherTypesOf(input.voucherTypes ?? null),
  };
  const where = { instituteId, branchScope: scopeOf(branchId) };
  const save = async () => {
    const row = await TallySettingsRow.findOne({ where });
    if (row) await row.update({ ...values, updatedByUserId: userId ?? null });
    else await TallySettingsRow.create({ ...where, branchId, ...values, updatedByUserId: userId ?? null });
  };
  try {
    await save();
  } catch (err) {
    // Two first saves at once: the unique key keeps one row; update it.
    if (!(err instanceof UniqueConstraintError)) throw err;
    await save();
  }
  const after = await settingsFor(instituteId, branchId);
  await auditFee({
    action: 'tally.settings.updated',
    entityType: 'tally_settings',
    entityId: scopeOf(branchId),
    before: before.values,
    after: after.values,
    metadata: { branchId },
  });
  return after;
}

// ------------------------------------------------------------------ mapping

async function loadOverrides(instituteId: number): Promise<Overrides> {
  const rows = await TallyLedgerMapping.findAll({
    where: { instituteId },
    attributes: ['branchScope', 'account', 'tallyName', 'parentGroup'],
  });
  const out: Overrides = new Map();
  for (const r of rows) {
    const name = cleanName(r.tallyName ?? '');
    const group = cleanName(r.parentGroup ?? '');
    if (!name || !group) continue;
    let scope = out.get(r.branchScope);
    if (!scope) out.set(r.branchScope, (scope = new Map()));
    scope.set(r.account, { name, group });
  }
  return out;
}

async function loadLookups(instituteId: number): Promise<MappingLookups> {
  const [banks, categories] = await Promise.all([
    BankAccount.findAll({ where: { instituteId }, attributes: ['id', 'name', 'branchId'] }),
    FinanceCategory.findAll({ where: { instituteId }, attributes: ['id', 'kind', 'name'] }),
  ]);
  return {
    banks: new Map(banks.map((b) => [b.id, { name: b.name, branchId: b.branchId }])),
    categories: new Map(categories.map((c) => [c.id, { kind: c.kind, name: c.name }])),
  };
}

/** The branch's own Tally list, else the institute's. */
async function loadKnown(instituteId: number, branchId: number | null): Promise<KnownList | null> {
  let scope = 0;
  if (branchId) {
    const own = await TallyKnownLedger.findOne({
      where: { instituteId, branchScope: branchId },
      attributes: ['id'],
    });
    if (own) scope = branchId;
  }
  const rows = await TallyKnownLedger.findAll({
    where: { instituteId, branchScope: scope },
    attributes: ['kind', 'name', 'parent', 'createdAt'],
  });
  if (!rows.length) return null;
  const known: KnownList = {
    branchId: scope || null,
    ledgers: new Map(),
    groups: new Map(),
    importedAt: rows[0].createdAt,
  };
  for (const r of rows) {
    const entry = { name: r.name, parent: r.parent };
    (r.kind === 'group' ? known.groups : known.ledgers).set(r.name.toLowerCase(), entry);
    if (r.createdAt > known.importedAt) known.importedAt = r.createdAt;
  }
  return known;
}

const knownInfo = (known: KnownList | null): TallyKnownLedgersInfo | null =>
  known
    ? {
        branchId: known.branchId,
        ledgers: known.ledgers.size,
        groups: known.groups.size,
        importedAt: known.importedAt.toISOString(),
      }
    : null;

/** Ledger accounts with entries in the scope (`null` = whole institute). */
async function usedAccounts(instituteId: number, branchId: number | null): Promise<Set<string>> {
  const rows = (await FeeLedgerEntry.findAll({
    where: { instituteId, ...(branchId ? { branchId } : {}) },
    attributes: ['account'],
    group: ['account'],
    raw: true,
  })) as unknown as { account: string }[];
  return new Set(rows.map((r) => r.account));
}

interface MappingState {
  branchId: number | null;
  overrides: Overrides;
  lookups: MappingLookups;
  known: KnownList | null;
  used: Set<string>;
}

async function mappingState(instituteId: number, branchId: number | null): Promise<MappingState> {
  const [overrides, lookups, known, used] = await Promise.all([
    loadOverrides(instituteId),
    loadLookups(instituteId),
    loadKnown(instituteId, branchId),
    usedAccounts(instituteId, branchId),
  ]);
  return { branchId, overrides, lookups, known, used };
}

/** Accounts listed for a scope: standard ones, its banks, every category and anything else used. */
function mappingAccounts(s: MappingState, extra: string[] = []): string[] {
  const accounts = STANDARD_ACCOUNTS.map((a) => a.account);
  for (const [id, bank] of s.lookups.banks)
    if (!s.branchId || bank.branchId === null || bank.branchId === s.branchId) accounts.push(`bank:${id}`);
  for (const [id, cat] of s.lookups.categories)
    accounts.push(`${cat.kind === 'income' ? 'income' : 'expense'}:${id}`);
  accounts.push(...[...s.used].sort(), ...extra);
  return unique(accounts);
}

function mappingItem(s: MappingState, account: string): TallyMappingItemDto {
  const def = accountDef(account, s.lookups);
  const mapped = resolveAccount(account, s.branchId, s.overrides, s.lookups);
  const inherited = s.branchId
    ? resolveAccount(account, null, s.overrides, s.lookups)
    : { name: def.defaultName, group: def.defaultGroup };
  const inTally = s.known?.ledgers.get(mapped.name.toLowerCase());
  const used = account.startsWith(`${L.GST_PAYABLE}:`) ? s.used.has(L.GST_PAYABLE) : s.used.has(account);
  return {
    account,
    label: def.label,
    kind: def.kind,
    tallyName: mapped.name,
    parentGroup: mapped.group,
    source: mapped.source,
    defaultName: def.defaultName,
    defaultGroup: def.defaultGroup,
    inheritedName: inherited.name,
    inheritedGroup: inherited.group,
    existsInTally: s.known ? Boolean(inTally) : null,
    tallyParent: inTally?.parent ?? null,
    groupKnown: knownGroup(mapped.group, s.known) !== null,
    cashOrBank: isCashBankGroup(effectiveParent(mapped.name, mapped.group, s.known), s.known),
    used,
  };
}

function mappingDto(s: MappingState): TallyMappingDto {
  const items = mappingAccounts(s).map((a) => mappingItem(s, a));
  const conflicts = findConflicts(
    items.map((i) => ({ account: i.account, name: i.tallyName, group: i.parentGroup })),
  );
  return {
    branchId: s.branchId,
    items,
    conflicts,
    unknownGroups: unique(
      items.filter((i) => !i.existsInTally && !i.groupKnown).map((i) => i.parentGroup),
    ).sort(),
    knownLedgers: knownInfo(s.known),
  };
}

export async function getMapping(requested: number | null | undefined): Promise<TallyMappingDto> {
  const branchId = await resolveScope(requested);
  return mappingDto(await mappingState(requireTenantContext().instituteId, branchId));
}

/** `bank:3`, `gateway:razorpay`, `fee_income`, `gst_payable:cgst` … */
export const ACCOUNT_PATTERN = /^[a-z][a-z0-9_]{0,40}(:[a-z0-9_.-]{1,40})?$/;

export async function updateMapping(input: TallyMappingUpdate): Promise<TallyMappingDto> {
  const branchId = await resolveScope(input.branchId);
  const { instituteId, userId } = requireTenantContext();
  const scope = scopeOf(branchId);
  const state = await mappingState(instituteId, branchId);
  const next: Overrides = new Map([...state.overrides].map(([k, v]) => [k, new Map(v)]));
  const own = next.get(scope) ?? new Map<string, { name: string; group: string }>();
  next.set(scope, own);
  const changes: { account: string; before: unknown; after: unknown }[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!ACCOUNT_PATTERN.test(item.account)) throw BadRequest(`Unknown ledger account ${item.account}`);
    if (seen.has(item.account)) throw BadRequest(`${item.account} is listed twice`);
    seen.add(item.account);
    const before = own.get(item.account) ?? null;
    if (item.tallyName == null) {
      own.delete(item.account);
    } else {
      const name = cleanName(item.tallyName);
      if (!name) throw BadRequest(`Enter a Tally ledger name for ${item.account}`);
      const inherited = branchId
        ? resolveAccount(item.account, null, state.overrides, state.lookups)
        : resolveAccount(item.account, null, new Map(), state.lookups);
      const group = cleanName(item.parentGroup ?? '') || inherited.group;
      own.set(item.account, { name, group });
    }
    const after = own.get(item.account) ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after))
      changes.push({ account: item.account, before, after });
  }

  const nextState = { ...state, overrides: next };
  const items = mappingAccounts(nextState, [...seen]).map((a) => mappingItem(nextState, a));
  const conflicts = findConflicts(
    items.map((i) => ({ account: i.account, name: i.tallyName, group: i.parentGroup })),
  ).filter((c) => c.accounts.some((a) => seen.has(a)));
  if (conflicts.length)
    throw Conflict(
      `Tally ledger "${conflicts[0].tallyName}" would be under more than one group (${conflicts[0].groups.join(', ')})`,
      'TALLY_MAPPING_CONFLICT',
      { conflicts },
    );

  if (changes.length) {
    await getSequelize().transaction(async (transaction) => {
      for (const c of changes) {
        const where = { instituteId, branchScope: scope, account: c.account };
        const value = own.get(c.account);
        if (!value) {
          await TallyLedgerMapping.destroy({ where, transaction });
          continue;
        }
        const row = await TallyLedgerMapping.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
        const data = { tallyName: value.name, parentGroup: value.group, updatedByUserId: userId ?? null };
        if (row) await row.update(data, { transaction });
        else await TallyLedgerMapping.create({ ...where, branchId, ...data }, { transaction });
      }
    });
    await auditFee({
      action: 'tally.mapping.updated',
      entityType: 'tally_mapping',
      entityId: scope,
      metadata: { branchId, changes },
    });
  }
  return mappingDto(await mappingState(instituteId, branchId));
}

// ------------------------------------------------------------------ Tally ledger list

export async function importKnownLedgers(
  requested: number | null | undefined,
  file: { path: string; size: number },
): Promise<TallyLedgerImportResult> {
  const branchId = await resolveScope(requested);
  const { instituteId } = requireTenantContext();
  if (file.size > TALLY_LIMITS.maxLedgerListMb * 1024 * 1024)
    throw new AppError(
      413,
      'FILE_TOO_LARGE',
      `The Tally list can be at most ${TALLY_LIMITS.maxLedgerListMb} MB`,
    );
  const parsed = parseTallyLedgerList(decodeTallyFile(await fs.readFile(file.path)));
  if (!parsed.ledgers.length && !parsed.groups.length)
    throw new AppError(
      400,
      'TALLY_LIST_EMPTY',
      'No Tally ledgers or groups found. Export the List of Accounts from Tally as XML (Data Interchange).',
    );
  const scope = scopeOf(branchId);
  await getSequelize().transaction(async (transaction) => {
    await TallyKnownLedger.destroy({ where: { instituteId, branchScope: scope }, transaction });
    for (const part of chunks([...parsed.groups, ...parsed.ledgers]))
      await TallyKnownLedger.bulkCreate(
        part.map((e) => ({
          instituteId,
          branchId,
          branchScope: scope,
          kind: e.kind,
          name: e.name,
          parent: e.parent,
        })),
        { transaction },
      );
  });
  const mapping = mappingDto(await mappingState(instituteId, branchId));
  const names = new Map(mapping.items.map((i) => [i.tallyName.toLowerCase(), i.existsInTally]));
  const matched = [...names.values()].filter(Boolean).length;
  await auditFee({
    action: 'tally.ledgers.imported',
    entityType: 'tally_ledger_list',
    entityId: scope,
    metadata: {
      branchId,
      ledgers: parsed.ledgers.length,
      groups: parsed.groups.length,
      ignored: parsed.ignored,
    },
  });
  return {
    branchId,
    ledgers: parsed.ledgers.length,
    groups: parsed.groups.length,
    matched,
    missing: names.size - matched,
  };
}

export async function getKnownLedgers(
  requested: number | null | undefined,
  search?: string,
): Promise<TallyKnownLedgersDto> {
  const branchId = await resolveScope(requested);
  const known = await loadKnown(requireTenantContext().instituteId, branchId);
  const needle = search?.trim().toLowerCase();
  const pick = (kind: TallyKnownLedgerDto['kind'], entries: KnownList['ledgers']): TallyKnownLedgerDto[] =>
    [...entries.values()]
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, LIST_LIMIT)
      .map((e) => ({ kind, name: e.name, parent: e.parent }));
  return {
    branchId,
    info: knownInfo(known),
    ledgers: known ? pick('ledger', known.ledgers) : [],
    groups: known ? pick('group', known.groups) : [],
  };
}

export async function clearKnownLedgers(requested: number | null | undefined): Promise<{ deleted: number }> {
  const branchId = await resolveScope(requested);
  const { instituteId } = requireTenantContext();
  const deleted = await TallyKnownLedger.destroy({ where: { instituteId, branchScope: scopeOf(branchId) } });
  if (deleted)
    await auditFee({
      action: 'tally.ledgers.cleared',
      entityType: 'tally_ledger_list',
      entityId: scopeOf(branchId),
      metadata: { branchId, deleted },
    });
  return { deleted };
}

// ------------------------------------------------------------------ building vouchers

interface Period {
  instituteId: number;
  branchId: number | null;
  from: string;
  to: string;
}

const periodWhere = (p: Period) => ({
  instituteId: p.instituteId,
  entryDate: { [Op.between]: [p.from, p.to] },
  ...(p.branchId ? { branchId: p.branchId } : {}),
});

/** Journals with entries in the period and scope (a branch export also leaves out entries without a branch). */
function journalCount(p: Period): Promise<number> {
  return FeeLedgerEntry.count({
    where: periodWhere(p) as WhereOptions<FeeLedgerEntry>,
    distinct: true,
    col: 'journalKey',
  });
}

const LEDGER_ATTRIBUTES = [
  'id',
  'journalKey',
  'line',
  'entryDate',
  'branchId',
  'account',
  'debit',
  'credit',
  'feeAccountId',
  'refType',
  'refId',
  'narration',
  'createdAt',
];

function toLedgerRows(rows: Record<string, unknown>[]): LedgerRow[] {
  return rows.map((r) => ({
    id: Number(r.id),
    journalKey: String(r.journalKey),
    line: Number(r.line),
    entryDate: dateStr(r.entryDate),
    branchId: r.branchId == null ? null : Number(r.branchId),
    account: String(r.account),
    debit: Number(r.debit ?? 0),
    credit: Number(r.credit ?? 0),
    feeAccountId: r.feeAccountId == null ? null : Number(r.feeAccountId),
    refType: String(r.refType),
    refId: r.refId == null ? null : Number(r.refId),
    narration: r.narration == null ? null : String(r.narration),
    createdAt: r.createdAt ? new Date(r.createdAt as string) : null,
  }));
}

async function loadJournals(p: Period): Promise<JournalGroup[]> {
  const count = await journalCount(p);
  if (count > TALLY_LIMITS.maxVouchers)
    throw new AppError(
      400,
      'TALLY_TOO_MANY_VOUCHERS',
      `The period has ${count} journals; export at most ${TALLY_LIMITS.maxVouchers} at a time (choose a shorter period or one branch)`,
      { count, limit: TALLY_LIMITS.maxVouchers },
    );
  const rows = (await FeeLedgerEntry.findAll({
    where: periodWhere(p) as WhereOptions<FeeLedgerEntry>,
    attributes: LEDGER_ATTRIBUTES,
    order: [['id', 'ASC']],
    raw: true,
  })) as unknown as Record<string, unknown>[];
  return groupJournals(toLedgerRows(rows));
}

async function loadReceipts(
  instituteId: number,
  journals: JournalGroup[],
): Promise<Map<number, ReceiptInfo>> {
  const ids = unique(
    journals.filter((j) => j.refType === 'payment' && j.refId).map((j) => j.refId as number),
  );
  const out = new Map<number, ReceiptInfo>();
  for (const part of chunks(ids)) {
    const rows = await FeeReceipt.findAll({
      where: { instituteId, paymentId: part },
      attributes: ['id', 'paymentId', 'number', 'invoiceNumber', 'cgst', 'sgst', 'igst'],
      order: [['id', 'ASC']],
    });
    for (const r of rows)
      if (!out.has(r.paymentId))
        out.set(r.paymentId, {
          number: r.number,
          invoiceNumber: r.invoiceNumber,
          cgst: Number(r.cgst) || 0,
          sgst: Number(r.sgst) || 0,
          igst: Number(r.igst) || 0,
        });
  }
  return out;
}

/** "Name (Admission no.)" per fee account. */
async function loadStudents(instituteId: number, journals: JournalGroup[]): Promise<Map<number, string>> {
  const accountIds = unique(journals.map((j) => j.feeAccountId).filter((id): id is number => Boolean(id)));
  const studentOf = new Map<number, number>();
  for (const part of chunks(accountIds)) {
    const rows = await FeeAccount.findAll({
      where: { instituteId, id: part },
      attributes: ['id', 'studentId'],
    });
    for (const r of rows) studentOf.set(r.id, r.studentId);
  }
  const names = new Map<number, string>();
  for (const part of chunks(unique([...studentOf.values()]))) {
    const rows = await Student.findAll({
      where: { instituteId, id: part },
      attributes: ['id', 'name', 'admissionNumber'],
    });
    for (const s of rows) names.set(s.id, partyLedgerName(s, s.id));
  }
  const out = new Map<number, string>();
  for (const [accountId, studentId] of studentOf) {
    const name = names.get(studentId);
    if (name) out.set(accountId, name);
  }
  return out;
}

async function createBuilder(
  instituteId: number,
  branchId: number | null,
  settings: TallySettingsEffective,
  journals: JournalGroup[],
) {
  const [overrides, lookups, known, receipts, students] = await Promise.all([
    loadOverrides(instituteId),
    loadLookups(instituteId),
    loadKnown(instituteId, branchId),
    loadReceipts(instituteId, journals),
    loadStudents(instituteId, journals),
  ]);
  const builder = new VoucherBuilder({
    instituteId,
    receivableMode: settings.receivableMode,
    gstLedgers: settings.gstLedgers,
    voucherTypes: settings.voucherTypes,
    overrides,
    lookups,
    known,
    receipts,
    students,
  });
  return { builder, known };
}

/** Latest exported version of each journal in exports to `company` (`null` matches exports without a company). */
async function lastExported(
  instituteId: number,
  keys: string[],
  company: string | null,
): Promise<Map<string, { exportId: number; digest: string }>> {
  const rows: { journalKey: string; contentDigest: string; exportId: number }[] = [];
  for (const part of chunks(unique(keys)))
    rows.push(
      ...(await TallyExportVoucher.findAll({
        where: { instituteId, journalKey: part, status: 'exported' },
        attributes: ['id', 'journalKey', 'contentDigest', 'exportId'],
        order: [['id', 'ASC']],
      })),
    );
  const out = new Map<string, { exportId: number; digest: string }>();
  if (!rows.length) return out;
  const exports = await TallyExport.findAll({
    where: { instituteId, id: unique(rows.map((r) => r.exportId)) },
    attributes: ['id', 'companyName'],
  });
  const companyOf = new Map(exports.map((e) => [e.id, companyKey(e.companyName)]));
  const wanted = companyKey(company);
  for (const r of rows)
    if (companyOf.has(r.exportId) && companyOf.get(r.exportId) === wanted)
      out.set(r.journalKey, { exportId: r.exportId, digest: r.contentDigest });
  return out;
}

interface PlannedVoucher {
  voucher: BuiltVoucher;
  status: TallyVoucherStatus;
  reason: string | null;
}

interface ExportPlan {
  branchId: number | null;
  from: string;
  to: string;
  onlyNew: boolean;
  settings: TallySettingsEffective;
  planned: PlannedVoucher[];
  exported: BuiltVoucher[];
  masters: TallyMasterJson[];
  totals: TallyTotalJson[];
  unknownGroups: string[];
  conflicts: ReturnType<VoucherBuilder['conflicts']>;
  alreadyExported: number;
  changedSinceExport: number;
}

function checkPeriod(from: string, to: string) {
  if (from > to) throw BadRequest('The period ends before it starts');
  if (daysBetween(from, to) + 1 > TALLY_LIMITS.maxPeriodDays)
    throw BadRequest(`Export at most ${TALLY_LIMITS.maxPeriodDays} days at a time`);
}

async function planExport(req: TallyExportRequest): Promise<ExportPlan> {
  checkPeriod(req.from, req.to);
  const branchId = await resolveScope(req.branchId);
  const { instituteId } = requireTenantContext();
  const onlyNew = Boolean(req.onlyNew);
  const { effective: settings } = await settingsFor(instituteId, branchId);
  const journals = await loadJournals({ instituteId, branchId, from: req.from, to: req.to });
  const { builder, known } = await createBuilder(instituteId, branchId, settings, journals);
  const vouchers = journals.map((j) => builder.build(j));
  const previous = await lastExported(
    instituteId,
    vouchers.filter((v) => !v.skipReason).map((v) => v.journalKey),
    settings.companyName,
  );
  let alreadyExported = 0;
  let changedSinceExport = 0;
  const planned = vouchers.map((voucher): PlannedVoucher => {
    if (voucher.skipReason) return { voucher, status: 'skipped', reason: voucher.skipReason };
    const prev = previous.get(voucher.journalKey);
    if (prev && prev.digest === voucher.contentDigest) {
      alreadyExported++;
      if (onlyNew)
        return {
          voucher,
          status: 'previous',
          reason: `Already exported unchanged in export #${prev.exportId}`,
        };
    } else if (prev) changedSinceExport++;
    return { voucher, status: 'exported', reason: null };
  });
  const exported = planned.filter((p) => p.status === 'exported').map((p) => p.voucher);
  const masters = mastersFor(exported, known);
  return {
    branchId,
    from: req.from,
    to: req.to,
    onlyNew,
    settings,
    planned,
    exported,
    masters,
    totals: totalsFor(exported, known),
    unknownGroups: unique(masters.filter((m) => !knownGroup(m.parent, known)).map((m) => m.parent)).sort(),
    conflicts: builder.conflicts(),
    alreadyExported,
    changedSinceExport,
  };
}

const sumDebits = (vouchers: BuiltVoucher[]) => vouchers.reduce((s, v) => s + v.amount, 0);
const masterDto = (m: TallyMasterJson): TallyMasterDto => ({ name: m.name, parent: m.parent });

export async function previewExport(req: TallyExportRequest): Promise<TallyPreviewDto> {
  const plan = await planExport(req);
  return {
    from: plan.from,
    to: plan.to,
    branchId: plan.branchId,
    onlyNew: plan.onlyNew,
    companyName: plan.settings.companyName,
    receivableMode: plan.settings.receivableMode,
    counts: {
      vouchers: plan.exported.length,
      alreadyExported: plan.alreadyExported,
      changedSinceExport: plan.changedSinceExport,
      skipped: plan.planned.filter((p) => p.status === 'skipped').length,
    },
    byType: typeCountsOf(plan.exported),
    totals: plan.totals,
    totalAmount: sumDebits(plan.exported),
    newLedgers: plan.masters.map(masterDto),
    unknownGroups: plan.unknownGroups,
    conflicts: plan.conflicts,
    limit: TALLY_LIMITS.maxVouchers,
  };
}

export async function createExport(req: TallyExportRequest): Promise<TallyExportDto> {
  const plan = await planExport(req);
  if (plan.conflicts.length)
    throw Conflict(
      `Tally ledger "${plan.conflicts[0].tallyName}" is mapped under more than one group (${plan.conflicts[0].groups.join(', ')}). Fix the ledger mapping first.`,
      'TALLY_MAPPING_CONFLICT',
      { conflicts: plan.conflicts },
    );
  if (!plan.exported.length)
    throw new AppError(
      400,
      'TALLY_NOTHING_TO_EXPORT',
      plan.onlyNew && plan.alreadyExported
        ? 'Everything in this period has already been exported to this Tally company'
        : 'No accounting entries to export in this period',
    );
  const { instituteId, userId } = requireTenantContext();
  const counts = (status: TallyVoucherStatus) => plan.planned.filter((p) => p.status === status).length;
  const batch = await getSequelize().transaction(async (transaction: Transaction) => {
    const row = await TallyExport.create(
      {
        instituteId,
        branchId: plan.branchId,
        fromDate: plan.from,
        toDate: plan.to,
        onlyNew: plan.onlyNew,
        companyName: plan.settings.companyName,
        receivableMode: plan.settings.receivableMode,
        voucherCount: plan.exported.length,
        skippedCount: counts('skipped'),
        alreadyExportedCount: counts('previous'),
        ledgerCount: plan.masters.length,
        totalAmount: sumDebits(plan.exported),
        totals: plan.totals,
        typeCounts: typeCountsOf(plan.exported),
        masters: plan.masters,
        createdByUserId: userId ?? null,
      },
      { transaction },
    );
    for (const part of chunks(plan.planned, 500))
      await TallyExportVoucher.bulkCreate(
        part.map(({ voucher: v, status, reason }) => ({
          instituteId,
          branchId: v.branchId,
          exportId: row.id,
          journalKey: v.journalKey,
          refType: v.refType,
          refId: v.refId,
          entryDate: v.entryDate,
          voucherType: v.voucherType,
          voucherNumber: v.voucherNumber,
          remoteId: v.remoteId,
          partyLedger: v.partyLedger,
          narration: v.narration,
          lines: v.lines.map((l) => ({ ledger: l.ledger, amount: l.amount })),
          amount: v.amount,
          fingerprint: v.fingerprint,
          contentDigest: v.contentDigest,
          status,
          skipReason: reason,
        })),
        { transaction },
      );
    return row;
  });
  await auditFee({
    action: 'tally.export.created',
    entityType: 'tally_export',
    entityId: batch.id,
    metadata: {
      branchId: plan.branchId,
      from: plan.from,
      to: plan.to,
      onlyNew: plan.onlyNew,
      companyName: plan.settings.companyName,
      vouchers: batch.voucherCount,
      skipped: batch.skippedCount,
      alreadyExported: batch.alreadyExportedCount,
      totalAmount: batch.totalAmount,
    },
  });
  return (await exportDtos([batch]))[0];
}

// ------------------------------------------------------------------ history

function totalsOf(value: unknown): TallyLedgerTotal[] {
  const v = parseJson(value);
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (t): t is TallyLedgerTotal =>
        Boolean(t) &&
        typeof t.ledger === 'string' &&
        typeof t.parent === 'string' &&
        Number.isSafeInteger(t.debit) &&
        Number.isSafeInteger(t.credit),
    )
    .map((t) => ({ ledger: t.ledger, parent: t.parent, debit: t.debit, credit: t.credit }));
}

function mastersOf(value: unknown): TallyMasterJson[] {
  const v = parseJson(value);
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (m): m is TallyMasterJson => Boolean(m) && typeof m.name === 'string' && typeof m.parent === 'string',
    )
    .map((m) => ({
      name: m.name,
      parent: m.parent,
      gstDutyHead: typeof m.gstDutyHead === 'string' ? m.gstDutyHead : null,
    }))
    .filter((m) => m.name && m.parent);
}

function typeCountsOfJson(value: unknown): Record<string, number> {
  const v = parseJson(value);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (e): e is [string, number] => Number.isSafeInteger(e[1]) && (e[1] as number) >= 0,
    ),
  );
}

const exportPeriod = (b: TallyExport): Period => ({
  instituteId: b.instituteId,
  branchId: b.branchId,
  from: dateStr(b.fromDate),
  to: dateStr(b.toDate),
});

async function exportDtos(batches: TallyExport[]): Promise<TallyExportDto[]> {
  if (!batches.length) return [];
  const { instituteId } = requireTenantContext();
  const branchIds = unique(batches.map((b) => b.branchId).filter((id): id is number => Boolean(id)));
  const userIds = unique(batches.map((b) => b.createdByUserId).filter((id): id is number => Boolean(id)));
  const [branches, users, journals] = await Promise.all([
    branchIds.length
      ? Branch.findAll({ where: { instituteId, id: branchIds }, attributes: ['id', 'name'] })
      : [],
    userIds.length ? User.findAll({ where: { id: userIds }, attributes: ['id', 'name'] }) : [],
    Promise.all(batches.map((b) => journalCount(exportPeriod(b)))),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  return batches.map((b, i) => {
    const covered = b.voucherCount + b.skippedCount + b.alreadyExportedCount;
    return {
      id: b.id,
      branchId: b.branchId,
      branchName: b.branchId ? (branchName.get(b.branchId) ?? null) : null,
      from: dateStr(b.fromDate),
      to: dateStr(b.toDate),
      onlyNew: Boolean(b.onlyNew),
      companyName: b.companyName,
      receivableMode: (b.receivableMode === 'party' ? 'party' : 'control') as TallyReceivableMode,
      voucherCount: b.voucherCount,
      skippedCount: b.skippedCount,
      alreadyExportedCount: b.alreadyExportedCount,
      ledgerCount: b.ledgerCount,
      totalAmount: b.totalAmount,
      typeCounts: typeCountsOfJson(b.typeCounts),
      createdAt: iso(b.createdAt) ?? '',
      createdBy: b.createdByUserId
        ? { id: b.createdByUserId, name: userName.get(b.createdByUserId) ?? 'Deleted user' }
        : null,
      // Every journal in scope when the batch was made has a row, so the rest came later.
      laterEntries: Math.max(0, journals[i] - covered),
    };
  });
}

const LIST_ATTRIBUTES = { exclude: ['totals', 'masters'] };

export async function listExports(q: {
  page: number;
  pageSize: number;
  branchId?: number | null;
}): Promise<{ items: TallyExportDto[]; total: number }> {
  const where = q.branchId === undefined ? {} : { branchId: q.branchId };
  const { rows, count } = await exportRepo.findAndCountAll({
    where: where as WhereOptions<TallyExport>,
    attributes: LIST_ATTRIBUTES,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  return { items: await exportDtos(rows), total: count };
}

export async function getExport(id: number): Promise<TallyExportDetailDto> {
  const batch = await exportRepo.findById(id);
  const skipped = await TallyExportVoucher.findAll({
    where: { instituteId: batch.instituteId, exportId: batch.id, status: 'skipped' },
    attributes: ['journalKey', 'entryDate', 'skipReason'],
    order: [['id', 'ASC']],
    limit: RECON_ITEM_LIMIT,
  });
  const [dto] = await exportDtos([batch]);
  return {
    ...dto,
    totals: totalsOf(batch.totals),
    masters: mastersOf(batch.masters).map(masterDto),
    skipped: skipped.map((s) => ({
      journalKey: s.journalKey,
      entryDate: dateStr(s.entryDate),
      reason: s.skipReason ?? '',
    })),
  };
}

// ------------------------------------------------------------------ files

export interface TallyFile {
  fileName: string;
  xml: string;
}

const fileName = (b: TallyExport, kind: 'masters' | 'vouchers') =>
  `tally-${b.id}-${dateStr(b.fromDate)}-to-${dateStr(b.toDate)}-${kind}.xml`;

function linesOf(value: unknown): XmlVoucher['lines'] | null {
  const v = parseJson(value);
  if (!Array.isArray(v)) return null;
  const lines = v.filter(
    (l): l is { ledger: string; amount: number } =>
      Boolean(l) && typeof l.ledger === 'string' && l.ledger !== '' && Number.isSafeInteger(l.amount),
  );
  return lines.length === v.length ? lines.map((l) => ({ ledger: l.ledger, amount: l.amount })) : null;
}

export async function exportFile(id: number, kind: 'masters' | 'vouchers'): Promise<TallyFile> {
  const batch = await exportRepo.findById(id);
  let xml: string;
  let count: number;
  if (kind === 'masters') {
    const ledgers: XmlLedger[] = mastersOf(batch.masters);
    xml = mastersXml(batch.companyName, ledgers);
    count = ledgers.length;
  } else {
    const rows = await TallyExportVoucher.findAll({
      where: { instituteId: batch.instituteId, exportId: batch.id, status: 'exported' },
      order: [
        ['entryDate', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const vouchers: XmlVoucher[] = [];
    for (const r of rows) {
      const lines = linesOf(r.lines);
      const v: XmlVoucher = {
        remoteId: r.remoteId,
        voucherType: r.voucherType,
        date: dateStr(r.entryDate),
        voucherNumber: r.voucherNumber,
        partyLedger: r.partyLedger,
        narration: r.narration,
        lines: lines ?? [],
      };
      try {
        // Rows are written balanced; never put a damaged one in a file.
        assertBalanced(v);
        tallyDate(v.date);
      } catch {
        continue;
      }
      vouchers.push(v);
    }
    xml = vouchersXml(batch.companyName, vouchers);
    count = vouchers.length;
  }
  await auditFee({
    action: 'tally.export.downloaded',
    entityType: 'tally_export',
    entityId: batch.id,
    metadata: { branchId: batch.branchId, file: kind, count },
  });
  return { fileName: fileName(batch, kind), xml };
}

// ------------------------------------------------------------------ reconciliation

interface BatchRow {
  id: number;
  journalKey: string;
  refType: string;
  refId: number | null;
  entryDate: string;
  voucherType: string;
  voucherNumber: string | null;
  amount: number;
  narration: string | null;
  fingerprint: string;
  contentDigest: string;
  status: TallyVoucherStatus;
}

async function batchRows(batch: TallyExport): Promise<BatchRow[]> {
  const rows = await TallyExportVoucher.findAll({
    where: { instituteId: batch.instituteId, exportId: batch.id },
    attributes: [
      'id',
      'journalKey',
      'refType',
      'refId',
      'entryDate',
      'voucherType',
      'voucherNumber',
      'amount',
      'narration',
      'fingerprint',
      'contentDigest',
      'status',
    ],
    order: [['id', 'ASC']],
  });
  return rows.map((r) => ({
    id: r.id,
    journalKey: r.journalKey,
    refType: r.refType,
    refId: r.refId,
    entryDate: dateStr(r.entryDate),
    voucherType: r.voucherType,
    voucherNumber: r.voucherNumber,
    amount: r.amount,
    narration: r.narration,
    fingerprint: r.fingerprint,
    contentDigest: r.contentDigest,
    status: r.status === 'skipped' || r.status === 'previous' ? r.status : 'exported',
  }));
}

/** Refunds / cancellations dated outside the period of vouchers the batch has in Tally. */
async function outOfPeriodReversals(p: Period, inTally: BatchRow[]): Promise<JournalGroup[]> {
  const byType = new Map<string, number[]>();
  for (const r of inTally) {
    if (r.refId == null) continue;
    byType.set(r.refType, [...(byType.get(r.refType) ?? []), r.refId]);
  }
  const rows: Record<string, unknown>[] = [];
  for (const [refType, ids] of byType)
    for (const part of chunks(unique(ids)))
      rows.push(
        ...((await FeeLedgerEntry.findAll({
          where: {
            instituteId: p.instituteId,
            refType,
            refId: part,
            [Op.or]: [{ entryDate: { [Op.lt]: p.from } }, { entryDate: { [Op.gt]: p.to } }],
            ...(p.branchId ? { branchId: p.branchId } : {}),
          } as WhereOptions<FeeLedgerEntry>,
          attributes: LEDGER_ATTRIBUTES,
          order: [['id', 'ASC']],
          raw: true,
        })) as unknown as Record<string, unknown>[]),
      );
  return groupJournals(toLedgerRows(rows).filter((r) => isReversal(r.journalKey)));
}

const refKey = (refType: string, refId: number | null) => `${refType}:${refId ?? ''}`;

export async function reconcileExport(id: number): Promise<TallyReconciliationDto> {
  const batch = await exportRepo.findById(id);
  const period = exportPeriod(batch);
  const { instituteId } = period;
  const rows = await batchRows(batch);
  const inTally = rows.filter((r) => r.status !== 'skipped');
  const [journals, reversals] = await Promise.all([
    loadJournals(period),
    outOfPeriodReversals(period, inTally),
  ]);
  // Current mapping and voucher types, but the batch's company and receivable structure: switching
  // between one receivable ledger and party ledgers is a new layout, not a change to reconcile.
  const { effective } = await settingsFor(instituteId, batch.branchId);
  const settings: TallySettingsEffective = {
    ...effective,
    companyName: batch.companyName,
    receivableMode: batch.receivableMode === 'party' ? 'party' : 'control',
  };
  const { builder, known } = await createBuilder(instituteId, batch.branchId, settings, [
    ...journals,
    ...reversals,
  ]);
  const current = new Map(journals.map((j) => [j.key, builder.build(j)]));
  const rowOf = new Map(rows.map((r) => [r.journalKey, r]));
  const originalOf = new Map<string, BatchRow>();
  for (const r of inTally)
    if (!originalOf.has(refKey(r.refType, r.refId))) originalOf.set(refKey(r.refType, r.refId), r);

  const items: TallyReconItemDto[] = [];
  const item = (
    flag: TallyReconFlag,
    v: BuiltVoucher,
    reverses: BatchRow | null = null,
  ): TallyReconItemDto => ({
    flag,
    journalKey: v.journalKey,
    entryDate: v.entryDate,
    refType: v.refType,
    refId: v.refId,
    voucherType: v.skipReason ? null : v.voucherType,
    voucherNumber: v.voucherNumber,
    amount: v.amount,
    narration: v.narration,
    recordedAt: iso(v.recordedAt),
    reverses: reverses ? (reverses.voucherNumber ?? reverses.journalKey) : null,
  });

  for (const r of rows) {
    const v = current.get(r.journalKey);
    if (!v) {
      if (r.status !== 'skipped')
        items.push({
          flag: 'removed',
          journalKey: r.journalKey,
          entryDate: r.entryDate,
          refType: r.refType,
          refId: r.refId,
          voucherType: r.voucherType,
          voucherNumber: r.voucherNumber,
          amount: r.amount,
          narration: r.narration,
          recordedAt: null,
          reverses: null,
        });
    } else if (v.fingerprint !== r.fingerprint) items.push(item('changed', v));
    else if (v.contentDigest !== r.contentDigest) items.push(item('mapping', v));
  }
  const fresh: BuiltVoucher[] = [];
  for (const [key, v] of current) {
    if (rowOf.has(key) || v.skipReason) continue;
    fresh.push(v);
    const original = isReversal(key) ? originalOf.get(refKey(v.refType, v.refId)) : undefined;
    items.push(original ? item('reversed', v, original) : item('new', v));
  }
  const later = reversals.map((j) => builder.build(j)).filter((v) => !v.skipReason);
  const laterExported = await lastExported(
    instituteId,
    later.map((v) => v.journalKey),
    batch.companyName,
  );
  for (const v of later) {
    const original = originalOf.get(refKey(v.refType, v.refId));
    if (original && !laterExported.has(v.journalKey)) items.push(item('reversed', v, original));
  }

  // What Tally should hold for this batch now: the current version of what it exported, plus new entries.
  const counted = batch.onlyNew
    ? [
        ...rows
          .filter((r) => r.status === 'exported')
          .map((r) => current.get(r.journalKey))
          .filter((v): v is BuiltVoucher => Boolean(v)),
        ...fresh,
      ]
    : [...current.values()];
  const currentTotals = totalsFor(counted, known);
  const exportedTotals = totalsOf(batch.totals);
  const totals = new Map<string, TallyReconTotalDto>();
  const totalFor = (ledger: string, parent: string) => {
    const key = ledger.toLowerCase();
    let t = totals.get(key);
    if (!t) {
      t = {
        ledger,
        parent,
        exportedDebit: 0,
        exportedCredit: 0,
        currentDebit: 0,
        currentCredit: 0,
        difference: 0,
      };
      totals.set(key, t);
    }
    return t;
  };
  for (const t of exportedTotals) {
    const row = totalFor(t.ledger, t.parent);
    row.exportedDebit += t.debit;
    row.exportedCredit += t.credit;
  }
  for (const t of currentTotals) {
    const row = totalFor(t.ledger, t.parent);
    row.parent = t.parent;
    row.currentDebit += t.debit;
    row.currentCredit += t.credit;
  }
  for (const t of totals.values())
    t.difference = t.currentDebit - t.currentCredit - (t.exportedDebit - t.exportedCredit);

  const order = new Map(TALLY_RECON_FLAGS.map((f, i) => [f, i]));
  items.sort(
    (a, b) =>
      (order.get(a.flag) ?? 0) - (order.get(b.flag) ?? 0) ||
      a.entryDate.localeCompare(b.entryDate) ||
      a.journalKey.localeCompare(b.journalKey),
  );
  const counts = Object.fromEntries(TALLY_RECON_FLAGS.map((f) => [f, 0])) as Record<TallyReconFlag, number>;
  for (const i of items) counts[i.flag]++;
  const totalRows = [...totals.values()].sort((a, b) => a.ledger.localeCompare(b.ledger));
  const exportedTotal = exportedTotals.reduce((s, t) => s + t.debit, 0);
  const currentTotal = sumDebits(counted);
  const [dto] = await exportDtos([batch]);
  return {
    export: dto,
    counts,
    items: items.slice(0, RECON_ITEM_LIMIT),
    truncated: items.length > RECON_ITEM_LIMIT,
    totals: totalRows,
    exportedTotal,
    currentTotal,
    inSync:
      items.length === 0 &&
      totalRows.every((t) => t.exportedDebit === t.currentDebit && t.exportedCredit === t.currentCredit),
    checkedAt: new Date().toISOString(),
  };
}
