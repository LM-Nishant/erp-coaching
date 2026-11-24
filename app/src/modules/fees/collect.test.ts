import { describe, expect, it } from 'vitest';
import { suggestedAmount } from './collect';

const inst = (seq: number, balance: number, overdue = false) => ({
  seq,
  label: `Instalment ${seq}`,
  dueDate: `2026-0${seq}-10`,
  balance,
  overdue,
});
type Account = Parameters<typeof suggestedAmount>[0];
const account = (balance: number, instalments: ReturnType<typeof inst>[]) =>
  ({ balance, instalments }) as unknown as Account;

describe('suggestedAmount', () => {
  it('collects everything overdue first', () => {
    expect(suggestedAmount(account(9000, [inst(3, 3000), inst(1, 3000, true), inst(2, 2000, true)]))).toEqual(
      {
        amount: 5000,
        kind: 'overdue',
        label: 'Instalment 1, Instalment 2',
        dueDate: '2026-01-10',
      },
    );
  });

  it('otherwise suggests the next unpaid instalment, skipping paid ones', () => {
    expect(suggestedAmount(account(5000, [inst(1, 0), inst(3, 2000), inst(2, 3000)]))).toMatchObject({
      amount: 3000,
      kind: 'next',
      label: 'Instalment 2',
    });
  });

  it('falls back to the balance and never exceeds it', () => {
    expect(suggestedAmount(account(1200, []))).toMatchObject({ amount: 1200, kind: 'balance', label: null });
    expect(suggestedAmount(account(1000, [inst(1, 4000, true)])).amount).toBe(1000);
  });
});
