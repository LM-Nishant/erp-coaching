import { useI18n } from 'vue-i18n';
import type { DashboardWidget } from '@/core/modules';
import { namespaceOf } from '@/i18n';

/**
 * i18n key of a widget's heading: `<module>.<name>` → `<moduleNamespace>.widgets.<name>`
 * (`live-classes.next` → `liveClasses.widgets.next`). Modules add that key to their own JSON.
 */
export function widgetTitleKey(id: string): string {
  const dot = id.indexOf('.');
  return dot < 0
    ? `${namespaceOf(id)}.widgets.title`
    : `${namespaceOf(id.slice(0, dot))}.widgets.${id.slice(dot + 1)}`;
}

/** Translated widget heading; falls back to the widget's English `title` when the key is missing. */
export function useWidgetTitle() {
  const { t, te } = useI18n();
  return (w: Pick<DashboardWidget, 'id' | 'title'>) => {
    const key = widgetTitleKey(w.id);
    return te(key) ? t(key) : w.title;
  };
}
