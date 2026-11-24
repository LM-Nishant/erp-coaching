import type { LmsAssignmentDto } from '@erp/shared';

/** Homework counts as "due soon" within this many hours of its deadline. */
export const DUE_SOON_HOURS = 48;

export type HomeworkState =
  'graded' | 'returned' | 'submitted' | 'overdue' | 'dueSoon' | 'pending' | 'closed';
export const HOMEWORK_TONE: Record<HomeworkState, 'success' | 'warning' | 'danger' | 'primary' | 'medium'> = {
  graded: 'success',
  returned: 'warning',
  submitted: 'primary',
  overdue: 'danger',
  dueSoon: 'warning',
  pending: 'medium',
  closed: 'medium',
};

/** Plain-language state of a learner's homework, from their own submission and the deadline. */
export function homeworkState(
  a: Pick<LmsAssignmentDto, 'dueAt' | 'status' | 'mySubmission'>,
  now = Date.now(),
): HomeworkState {
  const sub = a.mySubmission;
  if (sub) return sub.status;
  if (a.status === 'closed') return 'closed';
  const left = Date.parse(a.dueAt) - now;
  if (left < 0) return 'overdue';
  return left <= DUE_SOON_HOURS * 3_600_000 ? 'dueSoon' : 'pending';
}

/** `datetime-local` value (`YYYY-MM-DDTHH:MM`) of `d` in the device timezone. */
export const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export type DueChoice = 'tomorrow' | 'twoDays' | 'nextWeek';

/** Quick due dates for homework, all at 9 pm (students finish it the evening before class). */
export function dueAt(choice: DueChoice, now = new Date()) {
  const days = { tomorrow: 1, twoDays: 2, nextWeek: 7 }[choice];
  return toLocalInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 21, 0));
}

/** The quick choice a due date matches, if any. */
export const dueChoiceOf = (value: string, now = new Date()) =>
  (['tomorrow', 'twoDays', 'nextWeek'] as const).find((c) => dueAt(c, now) === value) ?? null;
