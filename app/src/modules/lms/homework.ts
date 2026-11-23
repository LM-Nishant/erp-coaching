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
