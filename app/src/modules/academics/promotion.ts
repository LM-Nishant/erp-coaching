import type {
  InstalmentPlan,
  PromotionFeeOptions,
  PromotionFeeStructureOption,
  PromotionRequest,
  PromotionResult,
} from '@erp/shared';
import { rupees } from '../hr/api';

/** The Promote dialog's choice of new-session fees. */
export interface PromotionFeeChoice {
  apply: boolean;
  structureId: number | null;
  /** YYYY-MM-DD; empty keeps the structure's own first due date. */
  firstDueDate: string;
}

export const noFees = (): PromotionFeeChoice => ({ apply: false, structureId: null, firstDueDate: '' });

/** Fees are on by default, with the most specific structure, whenever one applies to the target batch. */
export const defaultFeeChoice = (options: PromotionFeeOptions | null): PromotionFeeChoice =>
  options?.available && options.defaultStructureId !== null
    ? { apply: true, structureId: options.defaultStructureId, firstDueDate: '' }
    : noFees();

export function planLabel(plan: InstalmentPlan): string {
  switch (plan.type) {
    case 'one_time':
      return 'one time';
    case 'monthly':
      return `monthly × ${plan.count ?? 12}`;
    case 'quarterly':
      return `quarterly × ${plan.count ?? 4}`;
    case 'custom':
      return `custom × ${plan.custom?.length ?? 0}`;
  }
}

export const structureLabel = (s: PromotionFeeStructureOption) =>
  `${s.name} v${s.version} · ${rupees(s.total)} · ${planLabel(s.instalmentPlan)}`;

/** Custom plans carry their own due dates; the others start from a first due date. */
export const takesFirstDueDate = (s: PromotionFeeStructureOption | undefined) =>
  !!s && s.instalmentPlan.type !== 'custom';

export const firstDueDateHint = (s: PromotionFeeStructureOption) =>
  `Leave empty for ${s.instalmentPlan.firstDueDate ? `the structure's date, ${s.instalmentPlan.firstDueDate}` : 'today'}.`;

export function promotionRequest(
  batches: { fromBatchId: number; toBatchId: number },
  fee: PromotionFeeChoice,
  options: PromotionFeeOptions | null,
): PromotionRequest {
  const structure = options?.structures.find((s) => s.id === fee.structureId);
  if (!fee.apply || !structure) return { ...batches };
  const firstDueDate = takesFirstDueDate(structure) && fee.firstDueDate ? fee.firstDueDate : undefined;
  return { ...batches, fees: { structureId: structure.id, ...(firstDueDate ? { firstDueDate } : {}) } };
}

export interface SkipGroup {
  reason: string;
  count: number;
  /** The skipped students' names, where the response has them. */
  names: string[];
}

export interface PromotionSummary {
  headline: string;
  /** Students who weren't promoted, by reason. */
  skipped: SkipGroup[];
  /** Present when fees were applied. */
  fees?: { headline: string; skipped: SkipGroup[] };
}

const students = (n: number) => `${n} student${n === 1 ? '' : 's'}`;

function byReason(items: { reason?: string; studentName?: string }[]): SkipGroup[] {
  const groups = new Map<string, SkipGroup>();
  for (const { reason = 'Skipped', studentName } of items) {
    const group = groups.get(reason) ?? { reason, count: 0, names: [] };
    group.count += 1;
    if (studentName) group.names.push(studentName);
    groups.set(reason, group);
  }
  return [...groups.values()];
}

export function promotionSummary(r: PromotionResult): PromotionSummary {
  const fees = r.fees;
  return {
    headline: r.promoted ? `Promoted ${students(r.promoted)}` : 'No students were promoted',
    skipped: byReason(r.skipped),
    ...(fees
      ? {
          fees: {
            headline: fees.created
              ? `Billed ${students(fees.created)} with ${fees.structureName}`
              : `Nobody was billed with ${fees.structureName}`,
            skipped: byReason(fees.results.filter((x) => x.status === 'skipped')),
          },
        }
      : {}),
  };
}
