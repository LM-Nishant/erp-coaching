import { describe, expect, it } from 'vitest';
import { toCampaignAudience, whoOfRoles, type AudienceChoice } from './audience';

const choice = (c: Partial<AudienceChoice>): AudienceChoice => ({
  scope: 'institute',
  who: [],
  batchIds: [],
  branchId: null,
  ...c,
});

describe('toCampaignAudience', () => {
  it('maps whole-institute groups to roles, office staff to both staff roles', () => {
    expect(toCampaignAudience(choice({ who: ['parents', 'staff'], branchId: 4 }))).toEqual({
      roles: ['parent', 'accountant', 'branch-admin'],
      branchIds: [4],
    });
  });

  it('sends batch notices to the chosen members only, never office staff', () => {
    expect(
      toCampaignAudience(choice({ scope: 'batches', who: ['parents', 'staff'], batchIds: [2, 5] })),
    ).toEqual({
      batchIds: [2, 5],
      batchRecipients: ['parents'],
    });
  });

  it('is incomplete until someone is picked', () => {
    expect(toCampaignAudience(choice({}))).toBeNull();
    expect(toCampaignAudience(choice({ scope: 'batches', who: ['students'] }))).toBeNull();
    expect(toCampaignAudience(choice({ scope: 'batches', who: ['staff'], batchIds: [1] }))).toBeNull();
  });
});

describe('whoOfRoles', () => {
  it('names known groups in picker order and keeps custom roles', () => {
    expect(whoOfRoles(['teacher', 'reception', 'student', 'branch-admin'])).toEqual([
      'students',
      'teachers',
      'staff',
      'reception',
    ]);
  });
});
