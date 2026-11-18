/** Public cross-module API of the branches module. */

/**
 * Blocks closing a branch while it still has live data that must move first (e.g. active students
 * to transfer). Returns a human-readable reason, or null when the branch can be closed.
 */
export type BranchClosureGuard = (branchId: number) => Promise<string | null>;

const closureGuards = new Map<string, BranchClosureGuard>();

/** Registered by consuming modules from their `onReady` hook. */
export function registerBranchClosureGuard(name: string, guard: BranchClosureGuard): void {
  closureGuards.set(name, guard);
}

/** Reasons the branch cannot be closed (empty = it can). Runs in the tenant context. */
export async function branchClosureBlockers(branchId: number): Promise<string[]> {
  const reasons = await Promise.all([...closureGuards.values()].map((guard) => guard(branchId)));
  return reasons.filter((r): r is string => !!r);
}
