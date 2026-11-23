/** Greeting key for the hour of the day (0–23). */
export const greetingFor = (hour: number) => (hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening');

/** i18n key of a widget's card title: `attendance.teacher-today` → `attendance.widgets.teacherToday`. */
export function widgetTitleKey(id: string) {
  const [mod, name = ''] = id.split('.', 2);
  const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return `${camel(mod)}.widgets.${camel(name)}`;
}
