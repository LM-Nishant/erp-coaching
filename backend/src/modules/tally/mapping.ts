import {
  LEDGER_ACCOUNTS as L,
  TALLY_CASH_BANK_GROUPS,
  TALLY_LIMITS,
  TALLY_PREDEFINED_GROUPS,
  type TallyAccountKind,
  type TallyMappingConflictDto,
} from '@erp/shared';

/** Pseudo-accounts the GST payable lines are split into when GST ledgers are `split`. */
export const GST_HEADS = [
  { key: 'cgst', account: 'gst_payable:cgst', name: 'Output CGST', dutyHead: 'Central Tax' },
  { key: 'sgst', account: 'gst_payable:sgst', name: 'Output SGST', dutyHead: 'State Tax' },
  { key: 'igst', account: 'gst_payable:igst', name: 'Output IGST', dutyHead: 'Integrated Tax' },
] as const;
export type GstHeadKey = (typeof GST_HEADS)[number]['key'];

export interface AccountDef {
  account: string;
  label: string;
  kind: TallyAccountKind;
  defaultName: string;
  defaultGroup: string;
  /** GST duty head written on the ledger master (split GST ledgers only). */
  gstDutyHead: string | null;
}

const CORE: Omit<AccountDef, 'kind' | 'gstDutyHead'>[] = [
  {
    account: L.RECEIVABLE,
    label: 'Student fees receivable',
    defaultName: 'Student Fees Receivable',
    defaultGroup: 'Sundry Debtors',
  },
  {
    account: L.ADVANCE,
    label: 'Student fee advances',
    defaultName: 'Student Fee Advances',
    defaultGroup: 'Current Liabilities',
  },
  { account: L.FEE_INCOME, label: 'Fee income', defaultName: 'Fee Income', defaultGroup: 'Direct Incomes' },
  {
    account: L.LATE_FEE_INCOME,
    label: 'Late fee income',
    defaultName: 'Late Fee Income',
    defaultGroup: 'Indirect Incomes',
  },
  {
    account: L.DISCOUNTS,
    label: 'Fee concessions and discounts',
    defaultName: 'Fee Concessions & Discounts',
    defaultGroup: 'Indirect Expenses',
  },
  { account: L.CASH, label: 'Cash', defaultName: 'Cash', defaultGroup: 'Cash-in-Hand' },
  {
    account: L.UNDEPOSITED,
    label: 'Cheques / transfers not yet in a bank account',
    defaultName: 'Cheques in Hand',
    defaultGroup: 'Cash-in-Hand',
  },
  {
    account: L.GATEWAY_CHARGES,
    label: 'Payment gateway charges',
    defaultName: 'Payment Gateway Charges',
    defaultGroup: 'Indirect Expenses',
  },
  {
    account: L.EXPENSES,
    label: 'Expenses (no category)',
    defaultName: 'Expenses',
    defaultGroup: 'Indirect Expenses',
  },
  {
    account: L.OTHER_INCOME,
    label: 'Other income (no category)',
    defaultName: 'Other Income',
    defaultGroup: 'Indirect Incomes',
  },
];

const TAX: AccountDef[] = [
  {
    account: L.GST_PAYABLE,
    label: 'GST payable (one ledger)',
    kind: 'tax',
    defaultName: 'Output GST',
    defaultGroup: 'Duties & Taxes',
    gstDutyHead: null,
  },
  ...GST_HEADS.map((h) => ({
    account: h.account,
    label: `${h.key.toUpperCase()} payable`,
    kind: 'tax' as const,
    defaultName: h.name,
    defaultGroup: 'Duties & Taxes',
    gstDutyHead: h.dutyHead,
  })),
];

/** Accounts listed in every mapping, in display order. */
export const STANDARD_ACCOUNTS: AccountDef[] = [
  ...CORE.slice(0, 5).map((c) => ({ ...c, kind: 'core' as const, gstDutyHead: null })),
  ...TAX,
  ...CORE.slice(5).map((c) => ({ ...c, kind: 'core' as const, gstDutyHead: null })),
];
const STANDARD = new Map(STANDARD_ACCOUNTS.map((a) => [a.account, a]));

/** Trims, drops control characters and caps the length of a Tally ledger / group name. */
export function cleanName(value: string, max: number = TALLY_LIMITS.maxNameLength): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
      .trim()
  );
}

const title = (s: string) =>
  s
    .split(/[\s_:.-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

export interface MappingLookups {
  banks: Map<number, { name: string; branchId: number | null }>;
  categories: Map<number, { kind: string; name: string }>;
}

/** Label, kind and default Tally ledger of an app ledger account. */
export function accountDef(account: string, lookups: MappingLookups): AccountDef {
  const std = STANDARD.get(account);
  if (std) return std;
  const [prefix, rest = ''] = account.split(/:(.*)/s);
  const id = /^\d+$/.test(rest) ? Number(rest) : null;
  const def = (kind: TallyAccountKind, label: string, name: string, group: string): AccountDef => ({
    account,
    label,
    kind,
    defaultName: cleanName(name) || 'Unnamed',
    defaultGroup: group,
    gstDutyHead: null,
  });
  if (prefix === 'bank' && id) {
    const bank = lookups.banks.get(id);
    return def(
      'bank',
      `Bank: ${bank?.name ?? `#${id}`}`,
      bank?.name ?? `Bank Account ${id}`,
      'Bank Accounts',
    );
  }
  if (prefix === 'gateway' && rest) {
    const gw = title(rest);
    return def('gateway', `${gw} gateway (settlements due)`, `${gw} Gateway Clearing`, 'Bank Accounts');
  }
  if ((prefix === 'expense' || prefix === 'income') && id) {
    const cat = lookups.categories.get(id);
    const kind = prefix === 'expense' ? 'Expense' : 'Income';
    return def(
      prefix,
      `${kind}: ${cat?.name ?? `#${id}`}`,
      cat?.name ?? `${kind} ${id}`,
      prefix === 'expense' ? 'Indirect Expenses' : 'Indirect Incomes',
    );
  }
  // An account this version does not know: keep it visible in Tally until it is mapped.
  return def('core', account, title(account) || account, 'Suspense A/c');
}

export interface MappedLedger {
  name: string;
  group: string;
  source: 'branch' | 'institute' | 'default';
  gstDutyHead: string | null;
}

/** Overrides per branch scope (0 = institute) → account → Tally ledger. */
export type Overrides = Map<number, Map<string, { name: string; group: string }>>;

/** Branch override, then institute override, then the default. */
export function resolveAccount(
  account: string,
  branchId: number | null,
  overrides: Overrides,
  lookups: MappingLookups,
): MappedLedger {
  const def = accountDef(account, lookups);
  const branch = branchId ? overrides.get(branchId)?.get(account) : undefined;
  const inst = overrides.get(0)?.get(account);
  const hit = branch ?? inst;
  return {
    name: hit?.name ?? def.defaultName,
    group: hit?.group ?? def.defaultGroup,
    source: branch ? 'branch' : inst ? 'institute' : 'default',
    gstDutyHead: def.gstDutyHead,
  };
}

/** A Tally ledger list (ledgers and groups) keyed by lower-case name. */
export interface KnownList {
  branchId: number | null;
  ledgers: Map<string, { name: string; parent: string | null }>;
  groups: Map<string, { name: string; parent: string | null }>;
  importedAt: Date;
}

const PREDEFINED = new Map(
  Object.entries(TALLY_PREDEFINED_GROUPS).map(([name, parent]) => [name.toLowerCase(), { name, parent }]),
);
const CASH_BANK = new Set<string>(TALLY_CASH_BANK_GROUPS.map((g) => g.toLowerCase()));

/** Canonical spelling of a predefined or imported group, if it is one. */
export function knownGroup(group: string, known: KnownList | null): string | null {
  const key = group.toLowerCase();
  return known?.groups.get(key)?.name ?? PREDEFINED.get(key)?.name ?? null;
}

/** Whether `group` is, or sits beneath, a cash / bank group (imported groups first, then predefined). */
export function isCashBankGroup(group: string | null, known: KnownList | null): boolean {
  let current = group;
  for (let depth = 0; current && depth < 32; depth++) {
    const key = current.toLowerCase();
    if (CASH_BANK.has(key)) return true;
    current = known?.groups.get(key)?.parent ?? PREDEFINED.get(key)?.parent ?? null;
  }
  return false;
}

/** Group a ledger sits under in Tally: its parent in the imported list, else the mapping's group. */
export function effectiveParent(name: string, group: string, known: KnownList | null): string {
  return known?.ledgers.get(name.toLowerCase())?.parent ?? group;
}

/** Tally ledger names are case-insensitive: one name used with different groups is a conflict. */
export function findConflicts(
  entries: { account: string; name: string; group: string }[],
): TallyMappingConflictDto[] {
  const byName = new Map<string, { tallyName: string; groups: Map<string, string>; accounts: string[] }>();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    const hit = byName.get(key) ?? {
      tallyName: e.name,
      groups: new Map<string, string>(),
      accounts: [] as string[],
    };
    if (!hit.groups.has(e.group.toLowerCase())) hit.groups.set(e.group.toLowerCase(), e.group);
    if (!hit.accounts.includes(e.account)) hit.accounts.push(e.account);
    byName.set(key, hit);
  }
  return [...byName.values()]
    .filter((c) => c.groups.size > 1)
    .map((c) => ({ tallyName: c.tallyName, groups: [...c.groups.values()], accounts: c.accounts }));
}

/** Party ledger of a student in `party` mode: "Name (Admission no.)", within Tally's name limit. */
export function partyLedgerName(
  student: { name: string; admissionNumber: string | null },
  id: number,
): string {
  const suffix = ` (${cleanName(student.admissionNumber ?? '', 40) || `ST-${id}`})`;
  const name = cleanName(student.name ?? '', TALLY_LIMITS.maxNameLength - suffix.length) || 'Student';
  return `${name}${suffix}`;
}
