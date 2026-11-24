/** Common Indian test patterns, so a teacher picks one instead of filling in the marking scheme. */
export interface ExamPattern {
  id: 'simple' | 'jeeMain' | 'neet' | 'jeeAdvanced' | 'custom';
  defaultMarks: number;
  defaultNegativeMarks: number;
  durationMinutes: number;
  partialMarking: boolean;
}

export const EXAM_PATTERNS: readonly ExamPattern[] = [
  { id: 'simple', defaultMarks: 1, defaultNegativeMarks: 0, durationMinutes: 60, partialMarking: false },
  { id: 'jeeMain', defaultMarks: 4, defaultNegativeMarks: 1, durationMinutes: 180, partialMarking: false },
  { id: 'neet', defaultMarks: 4, defaultNegativeMarks: 1, durationMinutes: 200, partialMarking: false },
  { id: 'jeeAdvanced', defaultMarks: 4, defaultNegativeMarks: 2, durationMinutes: 180, partialMarking: true },
];

type Scheme = Omit<ExamPattern, 'id'>;

/** The preset an existing marking scheme matches, else `custom`. */
export function patternOf(s: Scheme): ExamPattern['id'] {
  return (
    EXAM_PATTERNS.find(
      (p) =>
        p.defaultMarks === s.defaultMarks &&
        p.defaultNegativeMarks === s.defaultNegativeMarks &&
        p.durationMinutes === s.durationMinutes &&
        p.partialMarking === s.partialMarking,
    )?.id ?? 'custom'
  );
}

/** `datetime-local` value (`YYYY-MM-DDTHH:MM`) of `d` in the device timezone. */
export const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Default opening time of a new test: tomorrow at 10:00. */
export function defaultOpens(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0);
}

/** When the test closes unless set: a fixed-time test, so opening time plus its duration. */
export const closesAfter = (opens: string, minutes: number) =>
  toLocalInput(new Date(new Date(opens).getTime() + Math.max(1, minutes || 0) * 60_000));
