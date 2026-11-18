import { describe, expect, it } from 'vitest';
import { canRequestDeletion, deletionTotals, formatBytes } from './api';

describe('tenant data helpers', () => {
  it('allows a new deletion request only when none is open (mirrors the API)', () => {
    expect(canRequestDeletion(null)).toBe(true);
    expect(canRequestDeletion({ status: 'rejected' })).toBe(true);
    expect(canRequestDeletion({ status: 'cancelled' })).toBe(true);
    for (const status of ['pending', 'approved', 'purging', 'completed', 'failed'] as const)
      expect(canRequestDeletion({ status })).toBe(false);
  });

  it('formats archive sizes', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(57011)).toBe('55.7 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
  });

  it('totals a completed purge, counting only tables that had rows', () => {
    const summary = {
      tables: { students: 120, fee_invoices: 300, website_pages: 0 },
      files: 42,
      users: 15,
      anonymizedUsers: 2,
      retainedTables: ['subscription_invoices'],
    };
    expect(deletionTotals({ summary })).toBe(
      '420 rows from 2 tables · 42 files · 15 user accounts deleted · 2 anonymised',
    );
    expect(deletionTotals({ summary: null })).toBe('');
  });
});
