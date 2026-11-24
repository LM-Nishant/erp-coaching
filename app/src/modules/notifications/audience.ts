import type { BatchRecipient, CampaignAudience } from '@erp/shared';

/** The groups a sender picks from in compose; `staff` exists only for whole-institute messages. */
export const AUDIENCE_WHO = ['students', 'parents', 'teachers', 'staff'] as const;
export type AudienceWho = (typeof AUDIENCE_WHO)[number];

/** What the audience picker edits; `toCampaignAudience` turns it into the API's filters. */
export interface AudienceChoice {
  scope: 'institute' | 'batches';
  who: AudienceWho[];
  batchIds: number[];
  /** One branch, or null for all (branch-limited senders always have theirs). */
  branchId: number | null;
}

const WHO_ROLES: Record<AudienceWho, string[]> = {
  students: ['student'],
  parents: ['parent'],
  teachers: ['teacher'],
  staff: ['accountant', 'branch-admin'],
};

/** API audience for a choice, or null while it is incomplete (nobody picked). */
export function toCampaignAudience(c: AudienceChoice): CampaignAudience | null {
  const branch = c.branchId ? { branchIds: [c.branchId] } : {};
  if (c.scope === 'batches') {
    const who = c.who.filter((w): w is BatchRecipient => w !== 'staff');
    if (!c.batchIds.length || !who.length) return null;
    return { batchIds: [...c.batchIds], batchRecipients: who, ...branch };
  }
  if (!c.who.length) return null;
  return { roles: c.who.flatMap((w) => WHO_ROLES[w]), ...branch };
}

/** Groups named by a sent campaign's roles, in picker order; unknown (custom) role slugs are kept as is. */
export function whoOfRoles(roles: readonly string[]): (AudienceWho | string)[] {
  const out: (AudienceWho | string)[] = AUDIENCE_WHO.filter((w) =>
    WHO_ROLES[w].some((r) => roles.includes(r)),
  );
  const known = Object.values(WHO_ROLES).flat();
  return [...out, ...roles.filter((r) => !known.includes(r))];
}
