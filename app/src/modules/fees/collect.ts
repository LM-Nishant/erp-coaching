import type { FeeAccountDto } from '@erp/shared';

export type SuggestionKind = 'overdue' | 'next' | 'balance';

export interface SuggestedAmount {
  /** Paise. */
  amount: number;
  kind: SuggestionKind;
  /** Instalment label(s) the amount settles, e.g. "Instalment 2". */
  label: string | null;
  dueDate: string | null;
}

/**
 * What the front desk most likely collects now: everything overdue, else the next unpaid instalment,
 * else the whole balance. Never more than the balance.
 */
export function suggestedAmount(a: Pick<FeeAccountDto, 'balance' | 'instalments'>): SuggestedAmount {
  const open = [...(a.instalments ?? [])].filter((i) => i.balance > 0).sort((x, y) => x.seq - y.seq);
  const overdue = open.filter((i) => i.overdue);
  const cap = (n: number) => Math.max(0, Math.min(n, a.balance));
  if (overdue.length) {
    return {
      amount: cap(overdue.reduce((s, i) => s + i.balance, 0)),
      kind: 'overdue',
      label: overdue.map((i) => i.label).join(', '),
      dueDate: overdue[0].dueDate,
    };
  }
  if (open.length) {
    return { amount: cap(open[0].balance), kind: 'next', label: open[0].label, dueDate: open[0].dueDate };
  }
  return { amount: cap(a.balance), kind: 'balance', label: null, dueDate: null };
}

/** Modes as big chips, most common first. */
export const COLLECT_MODES = ['cash', 'upi', 'cheque', 'bank_transfer'] as const;
