/**
 * Tally accounting export (TallyPrime, also importable into Tally.ERP 9). The app's double-entry
 * fee ledger is exported as Tally XML files (ledger masters + vouchers) that the accountant
 * imports in Tally; see docs/integrations/tally.md.
 */

/** Tally's predefined groups and their parents (`null` = primary group). */
export const TALLY_PREDEFINED_GROUPS: Readonly<Record<string, string | null>> = {
  'Branch / Divisions': null,
  'Capital Account': null,
  'Current Assets': null,
  'Current Liabilities': null,
  'Direct Expenses': null,
  'Direct Incomes': null,
  'Fixed Assets': null,
  'Indirect Expenses': null,
  'Indirect Incomes': null,
  Investments: null,
  'Loans (Liability)': null,
  'Misc. Expenses (ASSET)': null,
  'Purchase Accounts': null,
  'Sales Accounts': null,
  'Suspense A/c': null,
  'Bank Accounts': 'Current Assets',
  'Bank OD A/c': 'Loans (Liability)',
  'Cash-in-Hand': 'Current Assets',
  'Deposits (Asset)': 'Current Assets',
  'Duties & Taxes': 'Current Liabilities',
  'Loans & Advances (Asset)': 'Current Assets',
  Provisions: 'Current Liabilities',
  'Reserves & Surplus': 'Capital Account',
  'Secured Loans': 'Loans (Liability)',
  'Stock-in-Hand': 'Current Assets',
  'Sundry Creditors': 'Current Liabilities',
  'Sundry Debtors': 'Current Assets',
  'Unsecured Loans': 'Loans (Liability)',
};

/** Ledgers under these groups (or groups beneath them) are cash/bank ledgers in Tally. */
export const TALLY_CASH_BANK_GROUPS = ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'] as const;

/** Voucher classes the export distinguishes; each maps to a Tally voucher type name. */
export const TALLY_VOUCHER_TYPE_KEYS = ['receipt', 'payment', 'contra', 'journal', 'feeCharge'] as const;
export type TallyVoucherTypeKey = (typeof TALLY_VOUCHER_TYPE_KEYS)[number];
export type TallyVoucherTypes = Record<TallyVoucherTypeKey, string>;

/** Tally's built-in voucher types. Fee charges are journals unless a custom journal type is set. */
export const TALLY_DEFAULT_VOUCHER_TYPES: Readonly<TallyVoucherTypes> = {
  receipt: 'Receipt',
  payment: 'Payment',
  contra: 'Contra',
  journal: 'Journal',
  feeCharge: 'Journal',
};

export const TALLY_LIMITS = {
  /** Longest export period, in days. */
  maxPeriodDays: 366,
  /** Most vouchers in one export file. */
  maxVouchers: 20_000,
  /** Largest Tally ledger list accepted for import, in MB. */
  maxLedgerListMb: 25,
  /** Longest Tally ledger / group name accepted in the mapping. */
  maxNameLength: 100,
} as const;

/**
 * `control`: every student's dues post to one receivable ledger (e.g. "Student Fees Receivable").
 * `party`: each student gets a party ledger "Name (Admission no.)" under the receivable's group.
 */
export type TallyReceivableMode = 'control' | 'party';
/** `split`: Output CGST / SGST / IGST ledgers. `single`: one Output GST ledger. */
export type TallyGstLedgers = 'split' | 'single';

/** Settings stored for the institute or a branch; `null` fields inherit. */
export interface TallySettingsValues {
  /** Tally company the files are meant for (sets SVCURRENTCOMPANY). */
  companyName: string | null;
  receivableMode: TallyReceivableMode | null;
  gstLedgers: TallyGstLedgers | null;
  voucherTypes: Partial<TallyVoucherTypes> | null;
}

export interface TallySettingsEffective {
  companyName: string | null;
  receivableMode: TallyReceivableMode;
  gstLedgers: TallyGstLedgers;
  voucherTypes: TallyVoucherTypes;
}

export interface TallySettingsDto {
  /** `null` = institute-wide settings. */
  branchId: number | null;
  /** What is stored at this level. */
  values: TallySettingsValues;
  /** What exports for this scope use. */
  effective: TallySettingsEffective;
  /** What this level inherits: institute settings for a branch, built-in defaults for the institute. */
  inherited: TallySettingsEffective;
  updatedAt: string | null;
}

/** Replaces the settings stored at one level; omitted fields are stored as `null` (inherit). */
export interface TallySettingsUpdate extends Partial<Omit<TallySettingsValues, 'voucherTypes'>> {
  branchId?: number | null;
  /** Blank or `null` voucher type names inherit. */
  voucherTypes?: Partial<Record<TallyVoucherTypeKey, string | null>> | null;
}

export type TallyAccountKind = 'core' | 'tax' | 'bank' | 'gateway' | 'expense' | 'income';

export interface TallyMappingItemDto {
  /** App ledger account, e.g. `fee_income`, `bank:3`, `expense:7`, `gst_payable:cgst`. */
  account: string;
  label: string;
  kind: TallyAccountKind;
  /** Tally ledger and parent group used for this scope. */
  tallyName: string;
  parentGroup: string;
  /** Where the value comes from. */
  source: 'branch' | 'institute' | 'default';
  defaultName: string;
  defaultGroup: string;
  /** Value without this level's override (institute or default for a branch, default for the institute). */
  inheritedName: string;
  inheritedGroup: string;
  /** Whether the ledger is in the imported Tally list (`null`: no list imported). */
  existsInTally: boolean | null;
  /** The ledger's group in the imported Tally list. */
  tallyParent: string | null;
  /** Whether the group is predefined or in the imported Tally list. */
  groupKnown: boolean;
  /** Cash/bank ledger in Tally (decides Receipt / Payment / Contra). */
  cashOrBank: boolean;
  /** The ledger has entries in the app. */
  used: boolean;
}

export interface TallyMappingConflictDto {
  tallyName: string;
  groups: string[];
  accounts: string[];
}

export interface TallyKnownLedgersInfo {
  /** Scope the list was imported for (`null` = institute). A branch without a list uses the institute's. */
  branchId: number | null;
  ledgers: number;
  groups: number;
  importedAt: string;
}

export interface TallyMappingDto {
  branchId: number | null;
  items: TallyMappingItemDto[];
  /** One Tally ledger name used with different groups. Exports are blocked until fixed. */
  conflicts: TallyMappingConflictDto[];
  /** Groups that are neither predefined nor in the imported list; create them in Tally first. */
  unknownGroups: string[];
  knownLedgers: TallyKnownLedgersInfo | null;
}

export interface TallyMappingUpdate {
  branchId?: number | null;
  /** Overrides to store at this level; `tallyName: null` removes the override. */
  items: { account: string; tallyName: string | null; parentGroup?: string | null }[];
}

export interface TallyKnownLedgerDto {
  kind: 'ledger' | 'group';
  name: string;
  parent: string | null;
}

/**
 * The ledger list in effect for the scope (the branch's own, else the institute's), filtered by
 * `search`; at most 1,000 ledgers and 1,000 groups (`info` has the totals).
 */
export interface TallyKnownLedgersDto {
  branchId: number | null;
  info: TallyKnownLedgersInfo | null;
  ledgers: TallyKnownLedgerDto[];
  groups: TallyKnownLedgerDto[];
}

export interface TallyLedgerImportResult {
  branchId: number | null;
  ledgers: number;
  groups: number;
  /** Mapped ledgers found in the list. */
  matched: number;
  /** Mapped ledgers not in the list (they are created by the masters file). */
  missing: number;
}

/** Debit / credit totals (paise) per Tally ledger. */
export interface TallyLedgerTotal {
  ledger: string;
  parent: string;
  debit: number;
  credit: number;
}

export interface TallyMasterDto {
  name: string;
  parent: string;
}

export interface TallyExportRequest {
  from: string;
  to: string;
  /** `null` / omitted = all branches (institute-level users only). */
  branchId?: number | null;
  /** Leave out vouchers already exported unchanged to the same Tally company. */
  onlyNew?: boolean;
}

export interface TallyPreviewDto {
  from: string;
  to: string;
  branchId: number | null;
  onlyNew: boolean;
  companyName: string | null;
  receivableMode: TallyReceivableMode;
  counts: {
    /** Vouchers the file would contain. */
    vouchers: number;
    /** Journals already exported unchanged to this company (left out when `onlyNew`). */
    alreadyExported: number;
    /** Journals exported before whose voucher has changed since. */
    changedSinceExport: number;
    /** Journals left out of the file: they net to zero per Tally ledger, don't balance or have an invalid date. */
    skipped: number;
  };
  byType: Record<string, number>;
  totals: TallyLedgerTotal[];
  /** Sum of debits (paise). */
  totalAmount: number;
  /** Ledgers the masters file creates (not in the imported Tally list). */
  newLedgers: TallyMasterDto[];
  unknownGroups: string[];
  conflicts: TallyMappingConflictDto[];
  limit: number;
}

export interface TallyExportDto {
  id: number;
  branchId: number | null;
  branchName: string | null;
  from: string;
  to: string;
  onlyNew: boolean;
  companyName: string | null;
  receivableMode: TallyReceivableMode;
  voucherCount: number;
  /** Journals left out of the file (see `TallyPreviewDto.counts.skipped`). */
  skippedCount: number;
  /** Journals left out of an "only new" batch because they were exported unchanged before. */
  alreadyExportedCount: number;
  /** Ledgers in the masters file. */
  ledgerCount: number;
  totalAmount: number;
  typeCounts: Record<string, number>;
  createdAt: string;
  createdBy: { id: number; name: string } | null;
  /** Ledger entries in the period recorded after this export (review the reconciliation). */
  laterEntries: number;
}

export interface TallyExportDetailDto extends TallyExportDto {
  totals: TallyLedgerTotal[];
  masters: TallyMasterDto[];
  skipped: { journalKey: string; entryDate: string; reason: string }[];
}

/**
 * `new`: entry in the period recorded after the export. `changed`: entry differs from what was
 * exported. `removed`: exported entry no longer in the app. `reversed`: refund / cancellation of
 * an exported entry recorded after the export. `mapping`: same entry, but the Tally ledgers it maps
 * to changed.
 */
export const TALLY_RECON_FLAGS = ['new', 'changed', 'removed', 'reversed', 'mapping'] as const;
export type TallyReconFlag = (typeof TALLY_RECON_FLAGS)[number];

export interface TallyReconItemDto {
  flag: TallyReconFlag;
  journalKey: string;
  entryDate: string;
  refType: string;
  refId: number | null;
  voucherType: string | null;
  voucherNumber: string | null;
  /** Voucher amount (paise): exported amount for `removed`, current amount otherwise. */
  amount: number;
  narration: string | null;
  recordedAt: string | null;
  /** For `reversed`: the exported voucher it reverses. */
  reverses: string | null;
}

export interface TallyReconTotalDto {
  ledger: string;
  parent: string;
  exportedDebit: number;
  exportedCredit: number;
  currentDebit: number;
  currentCredit: number;
  /** (current − exported) net debit. */
  difference: number;
}

export interface TallyReconciliationDto {
  export: TallyExportDto;
  counts: Record<TallyReconFlag, number>;
  items: TallyReconItemDto[];
  /** More items than returned. */
  truncated: boolean;
  totals: TallyReconTotalDto[];
  exportedTotal: number;
  currentTotal: number;
  /** No flagged entries and identical totals. */
  inSync: boolean;
  checkedAt: string;
}
