import { describe, expect, it } from 'vitest';
import type { MeDto, TallyMappingItemDto } from '@erp/shared';
import { draftOf, mappingChanges, scopeOptions } from './api';

const item = (over: Partial<TallyMappingItemDto> = {}): TallyMappingItemDto => ({
  account: 'fee_income',
  label: 'Fee income',
  kind: 'core',
  tallyName: 'Fee Income',
  parentGroup: 'Direct Incomes',
  source: 'default',
  defaultName: 'Fee Income',
  defaultGroup: 'Direct Incomes',
  inheritedName: 'Fee Income',
  inheritedGroup: 'Direct Incomes',
  existsInTally: null,
  tallyParent: null,
  groupKnown: true,
  cashOrBank: false,
  used: true,
  ...over,
});

describe('mappingChanges', () => {
  it('sends only edited rows, trimmed, with a blank group left to the server', () => {
    const fee = item();
    const cash = item({ account: 'cash', tallyName: 'Cash', parentGroup: 'Cash-in-Hand' });
    expect(mappingChanges([fee, cash], {}, 'institute')).toEqual([]);
    expect(
      mappingChanges([fee, cash], { fee_income: draftOf(fee), cash: draftOf(cash) }, 'institute'),
    ).toEqual([]);
    expect(
      mappingChanges(
        [fee, cash],
        {
          fee_income: { tallyName: ' Tuition Fees ', parentGroup: 'Direct Incomes', reset: false },
          cash: { tallyName: 'Petty Cash', parentGroup: ' ', reset: false },
        },
        'institute',
      ),
    ).toEqual([
      { account: 'fee_income', tallyName: 'Tuition Fees', parentGroup: 'Direct Incomes' },
      { account: 'cash', tallyName: 'Petty Cash', parentGroup: null },
    ]);
  });

  it("removes this level's override on reset, a blank name or the inherited values typed back", () => {
    const own = item({ source: 'branch', tallyName: 'Fees Andheri', parentGroup: 'Sales Accounts' });
    const removal = [{ account: 'fee_income', tallyName: null }];
    for (const draft of [
      { ...draftOf(own), reset: true },
      { tallyName: '  ', parentGroup: 'Sales Accounts', reset: false },
      { tallyName: 'Fee Income', parentGroup: 'Direct Incomes', reset: false },
      { tallyName: 'Fee Income', parentGroup: '', reset: false },
    ])
      expect(mappingChanges([own], { fee_income: draft }, 'branch')).toEqual(removal);
  });

  it('has nothing to remove when the value comes from another level', () => {
    const fromInstitute = item({
      source: 'institute',
      tallyName: 'Tuition',
      inheritedName: 'Tuition',
    });
    expect(
      mappingChanges([fromInstitute], { fee_income: { ...draftOf(fromInstitute), reset: true } }, 'branch'),
    ).toEqual([]);
    expect(
      mappingChanges([item()], { fee_income: { tallyName: '', parentGroup: '', reset: false } }, 'institute'),
    ).toEqual([]);
  });
});

describe('scopeOptions', () => {
  const branches = [
    { id: 1, name: 'Andheri' },
    { id: 2, name: 'Thane' },
  ];
  const me = (allowedBranchIds: number[] | null) => ({ branches, allowedBranchIds }) as unknown as MeDto;

  it('offers all branches plus each branch to institute-level users', () => {
    expect(scopeOptions(me(null), null)).toEqual([
      { key: 'all', label: 'All branches (institute)' },
      { key: '1', label: 'Andheri' },
      { key: '2', label: 'Thane' },
    ]);
  });

  it('limits branch users to their branches and a selected branch to itself', () => {
    expect(scopeOptions(me([2]), null)).toEqual([{ key: '2', label: 'Thane' }]);
    expect(scopeOptions(me(null), 1)).toEqual([{ key: '1', label: 'Andheri' }]);
    expect(scopeOptions(null, null)).toEqual([]);
  });
});
