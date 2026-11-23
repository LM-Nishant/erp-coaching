import { describe, expect, it } from 'vitest';
import type { LmsAssignmentDto } from '@erp/shared';
import { homeworkState } from './homework';

const now = Date.parse('2026-12-01T10:00:00Z');
const hw = (o: Partial<LmsAssignmentDto>) =>
  ({ dueAt: '2026-12-10T10:00:00Z', status: 'published', mySubmission: null, ...o }) as LmsAssignmentDto;

describe('homeworkState', () => {
  it('follows the learner’s submission', () => {
    expect(homeworkState(hw({ mySubmission: { status: 'graded' } as never }), now)).toBe('graded');
    expect(
      homeworkState(
        hw({ dueAt: '2026-11-01T00:00:00Z', mySubmission: { status: 'submitted' } as never }),
        now,
      ),
    ).toBe('submitted');
  });
  it('reads the deadline when not submitted', () => {
    expect(homeworkState(hw({ status: 'closed' }), now)).toBe('closed');
    expect(homeworkState(hw({ dueAt: '2026-12-01T09:00:00Z' }), now)).toBe('overdue');
    expect(homeworkState(hw({ dueAt: '2026-12-03T10:00:00Z' }), now)).toBe('dueSoon');
    expect(homeworkState(hw({}), now)).toBe('pending');
  });
});
