import { describe, expect, it } from 'vitest';
import type { PlanAddonPrice, SubscriptionStatusDto } from '@erp/shared';
import {
  addonCyclePrice,
  addonSummary,
  cycleOffered,
  formatDay,
  limitsSummary,
  meterColor,
  meterValue,
  packSize,
  statusChip,
} from './format';

const status = (over: Partial<SubscriptionStatusDto>): SubscriptionStatusDto => ({
  state: 'active',
  planName: 'Starter',
  endsAt: null,
  graceEndsAt: null,
  suspendsAt: null,
  daysLeft: null,
  canManage: true,
  message: null,
  ...over,
});

describe('statusChip', () => {
  it('shows read-only and suspended access to everyone', () => {
    const viewer = { canManage: false, message: 'Contact your admin' };
    expect(statusChip(status({ ...viewer, state: 'suspended' }))).toEqual({
      label: 'Suspended',
      color: 'danger',
      detail: 'Contact your admin',
    });
    expect(statusChip(status({ ...viewer, state: 'restricted' }))?.label).toBe('Read-only');
  });

  it('keeps payment reminders for billing managers', () => {
    expect(statusChip(status({ state: 'grace' }))?.label).toBe('Payment due');
    expect(statusChip(status({ state: 'grace', canManage: false }))).toBeNull();
    expect(statusChip(status({ state: 'none' }))?.label).toBe('No plan');
    expect(statusChip(status({ state: 'none', canManage: false }))).toBeNull();
    expect(statusChip(null)).toBeNull();
  });

  it('counts down only the last week of a trial', () => {
    expect(statusChip(status({ state: 'trial', daysLeft: 10 }))).toBeNull();
    expect(statusChip(status({ state: 'trial', daysLeft: 7 }))?.label).toBe('Trial: 7 days left');
    expect(statusChip(status({ state: 'trial', daysLeft: 1 }))?.label).toBe('Trial: 1 day left');
    expect(statusChip(status({ state: 'trial', daysLeft: 0 }))?.label).toBe('Trial ends today');
    expect(statusChip(status({ state: 'trial', daysLeft: 3, canManage: false }))).toBeNull();
  });

  it('flags an active plan only when a renewal is due', () => {
    expect(statusChip(status({ daysLeft: 3 }))).toBeNull();
    expect(statusChip(status({ daysLeft: 3, message: 'Renewal invoice is open' }))?.label).toBe(
      'Renewal due',
    );
    expect(statusChip(status({ daysLeft: 0, message: 'Renewal invoice is open' }))?.label).toBe(
      'Renewal due today',
    );
  });
});

describe('usage meters', () => {
  it('warns at 80% and turns red at the limit; unlimited stays neutral', () => {
    expect(meterColor(null)).toBe('medium');
    expect(meterColor(79.9)).toBe('primary');
    expect(meterColor(80)).toBe('warning');
    expect(meterColor(100)).toBe('danger');
    expect(meterValue(null)).toBe(0);
    expect(meterValue(50)).toBe(0.5);
    expect(meterValue(150)).toBe(1);
  });
});

describe('plan and add-on wording', () => {
  it('describes packs with units, plurals and Indian digit grouping', () => {
    expect(packSize('branches', 1)).toBe('1 branch');
    expect(packSize('branches', 2)).toBe('2 branches');
    expect(packSize('storage', 2048)).toBe('2 GB');
    expect(packSize('storageMb', 512)).toBe('512 MB');
    expect(packSize('ai_credits', 100000)).toBe('1,00,000 AI tokens');
    expect(addonSummary({ kind: 'students', quantity: 2, unitSize: 50, moduleKey: null })).toBe(
      '2 × 50 students',
    );
    expect(addonSummary({ kind: 'module', quantity: 1, unitSize: 1, moduleKey: 'lms' })).toBe('lms module');
  });

  it('summarises limits, including unlimited and disabled AI', () => {
    const limits = {
      maxStudents: 200,
      maxBranches: 1,
      maxTeachers: null,
      storageMb: 5120,
      aiTokensMonthly: 0,
      enabledModules: null,
    };
    expect(limitsSummary(limits)).toBe('200 students · 1 branch · Unlimited teachers · 5 GB storage · No AI');
    expect(limitsSummary({ ...limits, aiTokensMonthly: null })).toContain('Unlimited AI');
    expect(limitsSummary({ ...limits, aiTokensMonthly: 200000 })).toContain('2,00,000 AI tokens/month');
  });
});

describe('pricing (mirrors the API)', () => {
  const students: PlanAddonPrice = {
    kind: 'students',
    unitSize: 50,
    monthlyPricePaise: 10000,
    yearlyPricePaise: 0,
  };

  it('prices add-on packs per cycle, falling back to 12 months for yearly', () => {
    expect(addonCyclePrice(students, 'monthly')).toBe(10000);
    expect(addonCyclePrice(students, 'yearly')).toBe(120000);
    expect(addonCyclePrice({ ...students, yearlyPricePaise: 100000 }, 'yearly')).toBe(100000);
    // AI credit packs are one-off purchases at a single price.
    expect(addonCyclePrice({ ...students, kind: 'ai_credits' }, 'yearly')).toBe(10000);
  });

  it('offers a cycle unless only the other one is priced', () => {
    const monthlyOnly = { priceMonthlyPaise: 199900, priceYearlyPaise: 0 };
    expect(cycleOffered(monthlyOnly, 'monthly')).toBe(true);
    expect(cycleOffered(monthlyOnly, 'yearly')).toBe(false);
    const free = { priceMonthlyPaise: 0, priceYearlyPaise: 0 };
    expect(cycleOffered(free, 'monthly')).toBe(true);
    expect(cycleOffered(free, 'yearly')).toBe(true);
  });
});

describe('formatDay', () => {
  it('shows invoice calendar days without a timezone shift', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(formatDay('2026-12-02')).toBe('2 Dec 2026');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
    expect(formatDay(null)).toBe('—');
    expect(formatDay('soon')).toBe('soon');
  });
});
