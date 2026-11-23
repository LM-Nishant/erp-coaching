import type { FeeAccountDto, FeeInstalmentDto } from '@erp/shared';

/** An instalment counts as "due soon" this many days before its due date. */
export const DUE_SOON_DAYS = 7;

export type InstalmentState = 'paid' | 'waived' | 'overdue' | 'dueSoon' | 'pending';
export const STATE_TONE: Record<InstalmentState, 'success' | 'warning' | 'danger' | 'medium'> = {
  paid: 'success',
  waived: 'medium',
  overdue: 'danger',
  dueSoon: 'warning',
  pending: 'medium',
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Plain-language state of an instalment on `today` (`YYYY-MM-DD`, default the device's date). */
export function instalmentState(i: FeeInstalmentDto, today = ymd(new Date())): InstalmentState {
  if (i.status === 'waived') return 'waived';
  if (i.balance <= 0 || i.status === 'paid') return 'paid';
  if (i.overdue || i.dueDate < today) return 'overdue';
  const soon = ymd(new Date(Date.parse(`${today}T00:00:00Z`) + DUE_SOON_DAYS * 86_400_000));
  return i.dueDate <= soon ? 'dueSoon' : 'pending';
}

/** The earliest unpaid instalment across active accounts: what to pay next. */
export function nextInstalment(
  accounts: readonly FeeAccountDto[],
): { account: FeeAccountDto; instalment: FeeInstalmentDto } | null {
  let best: { account: FeeAccountDto; instalment: FeeInstalmentDto } | null = null;
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    for (const instalment of account.instalments ?? []) {
      if (instalment.balance <= 0 || instalment.status === 'waived') continue;
      if (!best || instalment.dueDate < best.instalment.dueDate) best = { account, instalment };
    }
  }
  return best;
}

/** `tel:` link for an office phone number. */
export const telLink = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;
