import { describe, expect, it } from 'vitest';
import type { InstalmentPlan, PromotionFeeOptions, PromotionResult } from '@erp/shared';
import {
  defaultFeeChoice,
  firstDueDateHint,
  noFees,
  planLabel,
  promotionRequest,
  promotionSummary,
  structureLabel,
  takesFirstDueDate,
} from './promotion';

const structure = (id: number, instalmentPlan: InstalmentPlan) => ({
  id,
  name: 'Year 2 fees',
  version: 2,
  total: 1_200_000,
  branchId: null,
  batchId: null,
  academicSessionId: 7,
  instalmentPlan,
});
const quarterly = structure(1, { type: 'quarterly', count: 4, firstDueDate: '2041-04-10' });
const custom = structure(2, {
  type: 'custom',
  custom: [
    { label: 'Term 1', dueDate: '2041-04-01', percent: 50 },
    { label: 'Term 2', dueDate: '2041-10-01', percent: 50 },
  ],
});
const options: PromotionFeeOptions = {
  available: true,
  defaultStructureId: 1,
  structures: [quarterly, custom],
};
const batches = { fromBatchId: 10, toBatchId: 20 };

describe('promotion fees', () => {
  it('turns fees on with the default structure whenever one applies', () => {
    expect(defaultFeeChoice(options)).toEqual({ apply: true, structureId: 1, firstDueDate: '' });
    expect(defaultFeeChoice({ available: true, defaultStructureId: null, structures: [] })).toEqual(noFees());
    expect(defaultFeeChoice({ available: false, defaultStructureId: null, structures: [] })).toEqual(
      noFees(),
    );
    expect(defaultFeeChoice(null)).toEqual(noFees());
  });

  it('requests fees only when on, for an offered structure, with an optional first due date', () => {
    const request = (structureId: number, firstDueDate = '', apply = true) =>
      promotionRequest(batches, { apply, structureId, firstDueDate }, options);
    expect(request(1, '2041-06-15', false)).toEqual(batches);
    expect(request(1)).toEqual({ ...batches, fees: { structureId: 1 } });
    expect(request(1, '2041-06-15')).toEqual({
      ...batches,
      fees: { structureId: 1, firstDueDate: '2041-06-15' },
    });
    // Custom plans keep their own due dates.
    expect(request(2, '2041-06-15')).toEqual({ ...batches, fees: { structureId: 2 } });
    expect(request(99)).toEqual(batches);
    expect(promotionRequest(batches, { apply: true, structureId: 1, firstDueDate: '' }, null)).toEqual(
      batches,
    );
  });

  it('describes structures and their plans', () => {
    expect(structureLabel(quarterly)).toBe('Year 2 fees v2 · ₹12,000.00 · quarterly × 4');
    expect(planLabel({ type: 'monthly' })).toBe('monthly × 12');
    expect(planLabel({ type: 'quarterly' })).toBe('quarterly × 4');
    expect(planLabel({ type: 'one_time' })).toBe('one time');
    expect(planLabel(custom.instalmentPlan)).toBe('custom × 2');
    expect([takesFirstDueDate(quarterly), takesFirstDueDate(custom), takesFirstDueDate(undefined)]).toEqual([
      true,
      false,
      false,
    ]);
    expect(firstDueDateHint(quarterly)).toBe("Leave empty for the structure's date, 2041-04-10.");
    expect(firstDueDateHint(structure(3, { type: 'one_time' }))).toBe('Leave empty for today.');
  });

  it('summarises the promotion and its fees by reason, naming the students not billed', () => {
    const fees: NonNullable<PromotionResult['fees']> = {
      structureId: 1,
      structureName: 'Year 2 fees',
      created: 1,
      skipped: 3,
      results: [
        { studentUserId: 1, studentName: 'Asha', status: 'created', accountId: 5 },
        { studentUserId: 2, studentName: 'Ravi', status: 'skipped', reason: 'Already billed for this batch' },
        { studentUserId: 3, status: 'skipped', reason: 'No student record' },
        {
          studentUserId: 4,
          studentName: 'Meera',
          status: 'skipped',
          reason: 'Already billed for this batch',
        },
      ],
    };
    expect(
      promotionSummary({
        promoted: 4,
        skipped: [{ studentUserId: 9, reason: 'Already enrolled in target batch' }],
        fees,
      }),
    ).toEqual({
      headline: 'Promoted 4 students',
      skipped: [{ reason: 'Already enrolled in target batch', count: 1, names: [] }],
      fees: {
        headline: 'Billed 1 student with Year 2 fees',
        skipped: [
          { reason: 'Already billed for this batch', count: 2, names: ['Ravi', 'Meera'] },
          { reason: 'No student record', count: 1, names: [] },
        ],
      },
    });
    expect(promotionSummary({ promoted: 0, skipped: [] })).toEqual({
      headline: 'No students were promoted',
      skipped: [],
    });
    expect(
      promotionSummary({ promoted: 0, skipped: [], fees: { ...fees, created: 0, skipped: 0, results: [] } })
        .fees,
    ).toEqual({ headline: 'Nobody was billed with Year 2 fees', skipped: [] });
  });
});
