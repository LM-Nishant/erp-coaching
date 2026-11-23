import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { appModules, fitsPersona, groupMenu, tabsFor, type MenuItem } from './modules';
import { worksOffline } from '@/router';
import { useAuthStore } from '@/stores/auth';

/**
 * The signed-in user's menu: every module's `menu` items the user may open, sorted by `order`, with the
 * bottom tabs and the grouped menu built from them. Used by App.vue (side menu / "More") and TabBar.vue.
 */
export function useMenu() {
  const auth = useAuthStore();
  const router = useRouter();
  const { t } = useI18n();

  const items = computed(() => {
    const seen = new Set<string>();
    return appModules
      .flatMap((m) => m.menu ?? [])
      .filter((item) => {
        // Offline (app, cached profile): only pages that work without network.
        if (auth.offline && !worksOffline(router.resolve(item.path))) return false;
        if (item.visible && !item.visible()) return false;
        if (item.superAdmin) return auth.isPlatformAdmin;
        if (auth.isPlatformAdmin) return !item.permission;
        if (item.permission && !auth.can(item.permission)) return false;
        if (!fitsPersona(item, auth.me?.roles, auth.persona ?? undefined)) return false;
        return !item.planModule || auth.moduleEnabled(item.planModule);
      })
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .filter((item) => !seen.has(item.path) && !!seen.add(item.path));
  });
  const tabs = computed(() => (auth.persona ? tabsFor(items.value, auth.persona) : []));
  const groups = computed(() => groupMenu(items.value));
  const label = (item: MenuItem) => (item.titleKey ? t(item.titleKey) : item.title);
  const tabLabel = (item: MenuItem) => (item.tabTitleKey ? t(item.tabTitleKey) : label(item));
  return { items, tabs, groups, label, tabLabel };
}

const fold = (s: string) =>
  s
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

/**
 * Menu items whose label (in the user's language), English title or group name contains every word of
 * `query`, in menu order. An empty query finds nothing.
 */
export function searchMenu(
  items: readonly MenuItem[],
  query: string,
  label: (item: MenuItem) => string,
  groupLabel: (item: MenuItem) => string = () => '',
): MenuItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return items.filter((item) => {
    const text = fold(`${label(item)} ${item.title} ${groupLabel(item)}`);
    return words.every((w) => text.includes(w));
  });
}

/** The item a page at `path` belongs to: the longest item path that is `path` or one of its parent folders. */
export function activeItem<T extends Pick<MenuItem, 'path'>>(
  items: readonly T[],
  path: string,
): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    const inside = path === item.path || path.startsWith(item.path === '/' ? '/' : `${item.path}/`);
    if (inside && (!best || item.path.length > best.path.length)) best = item;
  }
  return best;
}
