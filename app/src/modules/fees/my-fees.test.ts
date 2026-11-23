import { describe, expect, it } from 'vitest';
import type { FeeAccountDto, FeeInstalmentDto } from '@erp/shared';
import { instalmentState, nextInstalment, telLink } from './my-fees';

const inst = (o: Partial<FeeInstalmentDto>) =>
  ({
    id: 1,
    dueDate: '2026-12-20',
    balance: 500,
    status: 'pending',
    overdue: false,
    ...o,
  }) as FeeInstalmentDto;
const account = (o: Partial<FeeAccountDto>) =>
  ({ id: 1, status: 'active', instalments: [], ...o }) as unknown as FeeAccountDto;

describe('instalmentState', () => {
  const today = '2026-12-01';
  it('reads paid, waived and overdue first', () => {
    expect(instalmentState(inst({ balance: 0 }), today)).toBe('paid');
    expect(instalmentState(inst({ status: 'waived' }), today)).toBe('waived');
    expect(instalmentState(inst({ dueDate: '2026-11-30' }), today)).toBe('overdue');
  });
  it('is due soon within seven days, else pending', () => {
    expect(instalmentState(inst({ dueDate: '2026-12-08' }), today)).toBe('dueSoon');
    expect(instalmentState(inst({ dueDate: '2026-12-09' }), today)).toBe('pending');
  });
});

describe('nextInstalment', () => {
  it('picks the earliest unpaid instalment of an active account', () => {
    const a = account({
      id: 1,
      instalments: [
        inst({ id: 1, dueDate: '2026-10-01', balance: 0 }),
        inst({ id: 2, dueDate: '2026-12-01' }),
      ],
    });
    const b = account({ id: 2, instalments: [inst({ id: 3, dueDate: '2026-11-01' })] });
    const closed = account({
      id: 3,
      status: 'closed' as never,
      instalments: [inst({ id: 4, dueDate: '2026-01-01' })],
    });
    expect(nextInstalment([a, b, closed])?.instalment.id).toBe(3);
    expect(nextInstalment([account({})])).toBeNull();
  });
});

it('telLink keeps digits and plus', () => {
  expect(telLink('+91 98765-43210')).toBe('tel:+919876543210');
});
