import { describe, expect, it } from 'vitest';
import type { QuestionImportDraftDto } from '@erp/shared';
import {
  buildSaveItems,
  changeType,
  needsAttention,
  reviewProblem,
  toReviewDraft,
  toggleCorrect,
  type ImportDefaults,
} from './pdf-import.helpers';

const defaults: ImportDefaults = {
  subjectId: 3,
  chapterId: null,
  topicId: null,
  difficulty: 'hard',
  defaultMarks: 4,
  defaultNegativeMarks: 1,
};

function draft(over: Partial<QuestionImportDraftDto> & { question: QuestionImportDraftDto['question'] }) {
  return {
    id: 'd1',
    number: '1',
    page: 1,
    flags: [],
    confidence: 0.9,
    diagrams: [],
    ...over,
  } as QuestionImportDraftDto;
}

describe('PDF import review helpers', () => {
  it('preselects complete drafts and leaves unanswered ones unselected and flagged', () => {
    const ok = toReviewDraft(
      draft({
        question: {
          type: 'single',
          text: 'Pick one',
          options: [
            { key: 'A', text: 'x' },
            { key: 'B', text: 'y' },
          ],
          answerKey: { options: ['B'] },
        },
      }),
    );
    expect(ok.selected).toBe(true);
    expect(needsAttention(ok)).toBe(false);

    const missing = toReviewDraft(
      draft({
        id: 'd2',
        flags: ['answer_missing'],
        question: { type: 'true_false', text: 'Sky is green', answerKey: {} },
      }),
    );
    expect(missing.selected).toBe(false);
    expect(reviewProblem(missing)).toBe('Choose True or False');
    expect(needsAttention(missing)).toBe(true);
    missing.trueFalse = 'false';
    expect(reviewProblem(missing)).toBeNull();
  });

  it('converts a numerical range into value ± tolerance and back', () => {
    const r = toReviewDraft(
      draft({ question: { type: 'numerical', text: 'Find x', answerKey: { min: 4, max: 6 } } }),
    );
    expect([r.numValue, r.numTolerance]).toEqual(['5', '1']);
    r.selected = true;
    const [item] = buildSaveItems([r], defaults);
    expect(item.question.answerKey).toEqual({ value: 5, tolerance: 1 });
  });

  it('applies defaults, keeps only ticked diagrams and skips unselected drafts', () => {
    const a = toReviewDraft(
      draft({
        diagrams: [
          { fileId: 7, url: '/a' },
          { fileId: 8, url: '/b' },
        ],
        question: { type: 'descriptive', text: ' Explain  ', answerKey: { modelAnswer: 'Because' } },
      }),
    );
    a.diagrams[1].keep = false;
    const b = toReviewDraft(
      draft({ id: 'd2', question: { type: 'descriptive', text: 'Other', answerKey: {} } }),
    );
    b.selected = false;
    const items = buildSaveItems([a, b], defaults);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      draftId: 'd1',
      diagramFileIds: [7],
      question: {
        text: 'Explain',
        subjectId: 3,
        difficulty: 'hard',
        defaultMarks: 4,
        defaultNegativeMarks: 1,
        source: 'import',
        answerKey: { modelAnswer: 'Because' },
      },
    });
  });

  it('keeps answers consistent when toggling options and changing type', () => {
    const r = toReviewDraft(draft({ question: { type: 'descriptive', text: 'Q', answerKey: {} } }));
    changeType(r, 'multiple');
    expect(r.options).toHaveLength(2);
    r.options[0].text = 'one';
    r.options[1].text = 'two';
    toggleCorrect(r, 'B');
    toggleCorrect(r, 'A');
    expect(r.correct).toEqual(['A', 'B']);
    changeType(r, 'single');
    expect(r.correct).toEqual(['A']);
    toggleCorrect(r, 'B');
    expect(r.correct).toEqual(['B']);
    expect(reviewProblem(r)).toBeNull();
  });
});
