import type { ComponentSlab, PayType, PayslipLine, StructureItem } from '@erp/shared';

/**
 * Pure payroll maths (no DB). All money is integer paise; rates are percentages.
 * Statutory rules come from institute-configurable components; nothing here hard-codes legal rates.
 */

export interface CalcComponent {
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  calcType: 'percent' | 'fixed' | 'slab';
  base: 'basic' | 'gross';
  employeeRate: number | null;
  employerRate: number | null;
  fixedAmount: number | null;
  wageCeiling: number | null;
  eligibilityMaxGross: number | null;
  slabs: ComponentSlab[] | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  sortOrder: number;
}

export interface CalcStructure {
  payType: PayType;
  monthlyBasic: number;
  ratePerUnit: number;
  allowances: StructureItem[] | null;
  deductions: StructureItem[] | null;
  pfApplicable: boolean;
  esiApplicable: boolean;
  ptApplicable: boolean;
  tdsApplicable: boolean;
  tdsPercent: number | null;
}

export interface CalcInput {
  structure: CalcStructure;
  components: CalcComponent[];
  daysInMonth: number;
  employedDays: number;
  lopDays: number;
  units: { lecture: number; class: number };
  incentives: number;
}

export interface CalcResult {
  payableDays: number;
  lines: PayslipLine[];
  gross: number;
  totalDeductions: number;
  net: number;
  employerContributions: number;
}

/** Structure flags that switch the matching statutory component on/off per employee. */
const APPLICABILITY: Record<string, keyof CalcStructure> = {
  PF: 'pfApplicable',
  ESI: 'esiApplicable',
  PT: 'ptApplicable',
  TDS: 'tdsApplicable',
};

const round = (n: number) => Math.round(n);
const slug = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30) || 'ITEM';

/** Components effective in the period; when a code has several versions the latest effectiveFrom wins. */
export function resolveComponents<T extends CalcComponent>(
  all: T[],
  periodStart: string,
  periodEnd: string,
): T[] {
  const byCode = new Map<string, T>();
  for (const c of all) {
    if (!c.active || c.effectiveFrom > periodEnd || (c.effectiveTo && c.effectiveTo < periodStart)) continue;
    const prev = byCode.get(c.code);
    if (!prev || c.effectiveFrom > prev.effectiveFrom) byCode.set(c.code, c);
  }
  return [...byCode.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

export function slabAmount(slabs: ComponentSlab[] | null, base: number): number {
  const sorted = [...(slabs ?? [])].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  return sorted.find((s) => s.upTo === null || base <= s.upTo)?.amount ?? 0;
}

export function calculatePayslip(input: CalcInput): CalcResult {
  const { structure: s, daysInMonth } = input;
  const payableDays = Math.max(0, Math.min(daysInMonth, input.employedDays) - input.lopDays);
  const factor = daysInMonth > 0 ? payableDays / daysInMonth : 0;
  const lines: PayslipLine[] = [];
  const earn = (code: string, name: string, amount: number) => {
    if (amount > 0 || code === 'BASIC') lines.push({ code, name, type: 'earning', amount });
  };

  let basic: number;
  if (s.payType === 'per_lecture') basic = round(input.units.lecture * s.ratePerUnit);
  else if (s.payType === 'per_class') basic = round(input.units.class * s.ratePerUnit);
  else basic = round(s.monthlyBasic * factor);
  earn(
    'BASIC',
    s.payType === 'fixed_monthly' ? 'Basic' : s.payType === 'per_lecture' ? 'Lecture pay' : 'Class pay',
    basic,
  );
  for (const a of s.allowances ?? []) earn(slug(a.name), a.name, round(a.amount * factor));
  earn('INCENTIVE', 'Incentives', round(input.incentives));

  const components = input.components;
  const applies = (c: CalcComponent) => {
    const flag = APPLICABILITY[c.code];
    return flag ? Boolean(s[flag]) : true;
  };
  const baseOf = (c: CalcComponent, gross: number) => {
    const raw = c.base === 'gross' ? gross : basic;
    return c.wageCeiling != null ? Math.min(raw, c.wageCeiling) : raw;
  };

  // Configured earnings (e.g. HRA as % of basic) are added before gross is known.
  for (const c of components.filter((x) => x.kind === 'earning' && applies(x))) {
    const grossSoFar = lines.reduce((t, l) => t + l.amount, 0);
    const base = baseOf(c, grossSoFar);
    const amount =
      c.calcType === 'percent'
        ? round((base * (c.employeeRate ?? 0)) / 100)
        : c.calcType === 'slab'
          ? slabAmount(c.slabs, base)
          : round((c.fixedAmount ?? 0) * factor);
    earn(c.code, c.name, amount);
  }
  const gross = lines.reduce((t, l) => t + l.amount, 0);

  for (const c of components.filter((x) => x.kind === 'deduction' && applies(x))) {
    if (c.eligibilityMaxGross != null && gross > c.eligibilityMaxGross) continue;
    const base = baseOf(c, gross);
    let employee: number;
    let employer = 0;
    if (c.calcType === 'percent') {
      const pct = c.code === 'TDS' && s.tdsPercent != null ? s.tdsPercent : (c.employeeRate ?? 0);
      employee = round((base * pct) / 100);
      employer = round((base * (c.employerRate ?? 0)) / 100);
    } else if (c.calcType === 'slab') {
      employee = gross > 0 ? slabAmount(c.slabs, base) : 0;
    } else {
      employee = gross > 0 ? (c.fixedAmount ?? 0) : 0;
    }
    if (employee > 0) lines.push({ code: c.code, name: c.name, type: 'deduction', amount: employee });
    if (employer > 0)
      lines.push({ code: `${c.code}_ER`, name: `${c.name} (employer)`, type: 'employer', amount: employer });
  }
  for (const d of s.deductions ?? []) {
    const amount = round(d.amount);
    if (amount > 0) lines.push({ code: slug(d.name), name: d.name, type: 'deduction', amount });
  }

  const totalDeductions = lines.filter((l) => l.type === 'deduction').reduce((t, l) => t + l.amount, 0);
  const employerContributions = lines.filter((l) => l.type === 'employer').reduce((t, l) => t + l.amount, 0);
  return { payableDays, lines, gross, totalDeductions, net: gross - totalDeductions, employerContributions };
}

/** Editable defaults seeded per institute. Rates are commonly used values, not legal advice. */
export const DEFAULT_COMPONENTS: Omit<CalcComponent, 'active'>[] = [
  {
    code: 'PF',
    name: 'Provident Fund',
    kind: 'deduction',
    calcType: 'percent',
    base: 'basic',
    employeeRate: 12,
    employerRate: 12,
    fixedAmount: null,
    wageCeiling: 15_000_00,
    eligibilityMaxGross: null,
    slabs: null,
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    sortOrder: 10,
  },
  {
    code: 'ESI',
    name: 'Employee State Insurance',
    kind: 'deduction',
    calcType: 'percent',
    base: 'gross',
    employeeRate: 0.75,
    employerRate: 3.25,
    fixedAmount: null,
    wageCeiling: null,
    eligibilityMaxGross: 21_000_00,
    slabs: null,
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    sortOrder: 20,
  },
  {
    code: 'PT',
    name: 'Professional Tax',
    kind: 'deduction',
    calcType: 'slab',
    base: 'gross',
    employeeRate: null,
    employerRate: null,
    fixedAmount: null,
    wageCeiling: null,
    eligibilityMaxGross: null,
    slabs: [
      { upTo: 7_500_00, amount: 0 },
      { upTo: 10_000_00, amount: 175_00 },
      { upTo: null, amount: 200_00 },
    ],
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    sortOrder: 30,
  },
  {
    code: 'TDS',
    name: 'Income Tax (TDS)',
    kind: 'deduction',
    calcType: 'percent',
    base: 'gross',
    employeeRate: 0,
    employerRate: null,
    fixedAmount: null,
    wageCeiling: null,
    eligibilityMaxGross: null,
    slabs: null,
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    sortOrder: 40,
  },
];
