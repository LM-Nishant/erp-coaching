import type { Transaction } from 'sequelize';
import type {
  PromotionFeeOptions,
  PromotionFeeRequest,
  PromotionFeeStudentResult,
  PromotionFeeSummary,
} from '@erp/shared';
import { hasPermission } from '../../shared/context';
import { Forbidden } from '../../shared/errors';

/** The batch students are promoted into. */
export interface PromotionFeeTarget {
  batchId: number;
  branchId: number;
  courseId: number;
  academicSessionId: number;
}

/** What a promotion does after its batch changes: bill the promoted students (spec §7 "new-session fees"). */
export interface PromotionFeePlan {
  structureId: number;
  structureName: string;
  /**
   * Bills the promoted students inside the promotion transaction. Students who can't be billed
   * (already billed for the batch, no student record, another branch) are skipped with a reason;
   * any thrown error rolls the whole promotion back.
   */
  apply(studentUserIds: number[], transaction: Transaction): Promise<PromotionFeeStudentResult[]>;
  /** Runs once the promotion committed (audit). */
  afterCommit(summary: PromotionFeeSummary, fromBatchId: number): Promise<void>;
}

/**
 * Extension point for the module that bills students (fees); academics never imports fees.
 * Register it from the provider's `integrations.ts` in `onReady`:
 *
 *   import { setPromotionFeeProvider } from '../academics/api';
 *   setPromotionFeeProvider({ options: async (target) => ..., prepare: async (target, choice) => plan });
 *
 * Without a provider, promotions can't apply fees (`available: false`).
 */
export interface PromotionFeeProvider {
  /** The fee structures that can bill students promoted into the target batch. */
  options(target: PromotionFeeTarget): Promise<PromotionFeeOptions>;
  /** Validates the choice before anything changes; throws when it can't be applied. */
  prepare(target: PromotionFeeTarget, choice: PromotionFeeRequest): Promise<PromotionFeePlan>;
}

let provider: PromotionFeeProvider | null = null;

export function setPromotionFeeProvider(p: PromotionFeeProvider | null): void {
  provider = p;
}

const assertCanBill = () => {
  if (!hasPermission('fees.create')) throw Forbidden('Missing permission fees.create', 'PERMISSION_DENIED');
};

export async function promotionFeeOptions(target: PromotionFeeTarget): Promise<PromotionFeeOptions> {
  assertCanBill();
  return provider ? provider.options(target) : { available: false, defaultStructureId: null, structures: [] };
}

export async function preparePromotionFees(
  target: PromotionFeeTarget,
  choice: PromotionFeeRequest,
): Promise<PromotionFeePlan> {
  assertCanBill();
  if (!provider) throw Forbidden('The fees module is not enabled for this institute', 'MODULE_DISABLED');
  return provider.prepare(target, choice);
}

export function summarizePromotionFees(
  plan: PromotionFeePlan,
  results: PromotionFeeStudentResult[],
): PromotionFeeSummary {
  const created = results.filter((r) => r.status === 'created').length;
  return {
    structureId: plan.structureId,
    structureName: plan.structureName,
    created,
    skipped: results.length - created,
    results,
  };
}
