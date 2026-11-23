import { describe, expect, it } from 'vitest';
import type { MktRefundDto } from '@erp/shared';
import { payoutPeriod, periodShort, refundOutcome, signedRupees } from './payouts-api';

describe('payout labels', () => {
  it('labels revenue periods for the chart', () => {
    expect(periodShort('2026-11')).toBe('Nov 26');
    expect(periodShort('2026-01-05')).toBe('5 Jan');
  });

  it('shows refunds and deductions as negative rupees', () => {
    expect(signedRupees(34930)).toBe('₹349.30');
    expect(signedRupees(-34930)).toBe('−₹349.30');
    expect(signedRupees(12345600)).toBe('₹1,23,456.00');
    expect(signedRupees(0)).toBe('₹0.00');
  });

  it('shows a payout period with an exclusive end in IST', () => {
    // 1 Oct – 1 Nov 2026 IST, stored as UTC instants.
    expect(payoutPeriod('2026-09-30T18:30:00.000Z', '2026-10-31T18:30:00.000Z')).toBe('1 Oct – 31 Oct 2026');
  });
});

describe('refundOutcome', () => {
  it('reports a refund the gateway refused instead of "Refunded"', () => {
    const failed = { status: 'failed', decisionNote: 'Gateway timeout' } as MktRefundDto;
    expect(refundOutcome(failed)).toEqual({ message: 'Refund failed: Gateway timeout', color: 'danger' });
    expect(refundOutcome({ status: 'refunded' } as MktRefundDto)).toEqual({
      message: 'Refunded',
      color: 'success',
    });
  });
});
