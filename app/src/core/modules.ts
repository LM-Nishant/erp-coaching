import type { Component } from 'vue';
import type { RouteLocationNormalized, RouteLocationRaw, RouteRecordRaw } from 'vue-router';
import type { ParentChildDto, PermissionKey, SystemRoleSlug } from '@erp/shared';
import { MAX_TABS, MENU_GROUPS, type MenuGroup, type Persona } from './persona';

export interface MenuItem {
  title: string;
  path: string;
  /** ionicons icon (import from 'ionicons/icons'). */
  icon: string;
  /** Shown only when the user has this permission. */
  permission?: PermissionKey;
  /**
   * Persona page whose permission other roles hold too: shown only to users with one of these roles
   * (e.g. My timetable needs `academics.view`, which staff have, but lists a teacher's or student's classes).
   */
  roles?: readonly SystemRoleSlug[];
  /** Platform (super admin, not impersonating) menu. */
  superAdmin?: boolean;
  /** Hidden when the institute's plan doesn't enable this module id (backend `requireModule`). */
  planModule?: string;
  /** Extra check, run first: when it returns false the item is hidden; when true the other checks still apply. */
  visible?: () => boolean;
  /** Lower comes first. Default 100. */
  order?: number;
  /** i18n key for the title (e.g. `fees.menu.myFees`); `title` stays the English fallback. */
  titleKey?: string;
  /** Section of the grouped "More" menu and desktop side menu. Default `other`. */
  group?: MenuGroup;
  /** Shown only to these personas (checked with `roles`; see core/persona.ts). Omit = every persona. */
  personas?: readonly Persona[];
  /**
   * Bottom tab on phones for these personas: the position (lower first). Each persona gets its
   * `MAX_TABS - 1` lowest items plus "More". E.g. `{ student: 2 }` = second tab for students.
   */
  tab?: Partial<Record<Persona, number>>;
}

export interface AppModule {
  /** Matches the backend module name when there is one. */
  id: string;
  /** Pages rendered inside the authenticated shell. Use `meta.permission` / `meta.superAdmin` to guard. */
  routes?: RouteRecordRaw[];
  /** Pages available without login (login, OTP…). */
  publicRoutes?: RouteRecordRaw[];
  menu?: MenuItem[];
  /** Components rendered in every page's toolbar (end slot), e.g. the notifications bell. */
  toolbarItems?: Component[];
  /** Cards contributed to shared dashboards (see CONTRIBUTING "Dashboard widgets"). */
  widgets?: DashboardWidget[];
  /**
   * Removes data this module keeps on the device for a user (e.g. downloaded lectures) when their access ends: device
   * revoked by an administrator or account deactivated. `null` = unknown user, remove everything. See core/session.ts.
   */
  wipeUserData?: (userId: number | null) => Promise<void>;
  /**
   * Runs when the user signs out, while the session still works: undo what ties this device to the user (e.g. the push
   * token). Best effort; signing out goes ahead when it fails. See core/session.ts.
   */
  beforeSignOut?: () => Promise<void>;
  /**
   * Run after the login and permission checks of every signed-in navigation. Return `true` to
   * continue or a location to redirect to (e.g. a suspended institute goes to billing).
   */
  navigationGuards?: AppNavigationGuard[];
}

export type AppNavigationGuard = (
  to: RouteLocationNormalized,
) => true | RouteLocationRaw | Promise<true | RouteLocationRaw>;

/** Known dashboard slots and the props each passes to its widgets. */
export interface WidgetSlotProps {
  /** Parent home (`/parent-home`): one linked child at a time, switched by the parent. */
  'parent-home': { child: ParentChildDto };
  /** Home dashboard (`/home`) of institute users, every role; widgets scope data to the signed-in user. */
  home: Record<string, never>;
  /** Home dashboard (`/home`) of the platform super admin (not while impersonating). */
  'platform-home': Record<string, never>;
  /** "Today" home of the `student` persona: next class, continue watching, due work, fee due. */
  'student-home': Record<string, never>;
  /** "Today" home of the `teacher` persona: now/next class, quick actions, things to check. */
  'teacher-home': Record<string, never>;
  /** "Today" home of the `staff` persona (admins, accountant, front desk): quick actions, today's numbers, setup. */
  'staff-home': Record<string, never>;
}
export type WidgetSlot = keyof WidgetSlotProps;

export interface DashboardWidget<S extends WidgetSlot = WidgetSlot> {
  /** Unique id, `<module>.<widget>`, e.g. `fees.dues`. */
  id: string;
  slot: S;
  /** Card heading. */
  title: string;
  /** Rendered with the slot's props. Use `defineAsyncComponent(() => import('./MyCard.vue'))` to lazy-load. */
  component: Component;
  /** Shown only when the user has this permission (usually your module's parent-facing `view`). */
  permission?: PermissionKey;
  /** Hidden when the institute's plan doesn't enable this module id. */
  planModule?: string;
  /** Lower comes first. Default 100. */
  order?: number;
  /** `full` spans the whole row on wide screens; default `half`. */
  size?: 'half' | 'full';
}

export function defineAppModule(m: AppModule): AppModule {
  return m;
}

/** Whether a user with `roles` (and `persona`, when known) is someone `item` is for (`MenuItem.roles`/`personas`). */
export const fitsPersona = (item: MenuItem, roles: readonly string[] = [], persona?: Persona) =>
  (!item.roles || item.roles.some((r) => roles.includes(r))) &&
  (!item.personas || !persona || item.personas.includes(persona));

/** Bottom tabs of `persona` among already-filtered menu `items`: at most `MAX_TABS - 1`, "More" comes after. */
export function tabsFor(items: readonly MenuItem[], persona: Persona): MenuItem[] {
  return items
    .filter((i) => i.tab?.[persona] !== undefined)
    .sort((a, b) => a.tab![persona]! - b.tab![persona]!)
    .slice(0, MAX_TABS - 1);
}

/** Already-filtered menu `items` by `MenuItem.group`, in `MENU_GROUPS` order; empty groups left out. */
export function groupMenu(items: readonly MenuItem[]): { group: MenuGroup; items: MenuItem[] }[] {
  return MENU_GROUPS.map((group) => ({
    group,
    items: items.filter((i) => (i.group ?? 'other') === group),
  })).filter((g) => g.items.length > 0);
}

/**
 * Auto-discovers every `src/modules/<name>/module.ts`. A new feature module only adds its own folder —
 * no edits to the router, menu or App.vue are needed.
 */
export const appModules: AppModule[] = Object.values(
  import.meta.glob<{ default: AppModule }>('../modules/*/module.ts', { eager: true }),
).map((m) => m.default);

export const toolbarItems: Component[] = appModules.flatMap((m) => m.toolbarItems ?? []);

/** Runs every module's `wipeUserData`; one failing module doesn't stop the others. */
export async function wipeUserData(userId: number | null) {
  await Promise.all(appModules.map((m) => m.wipeUserData?.(userId).catch(() => undefined)));
}
/** Runs every module's `beforeSignOut`; failures are ignored. */
export async function beforeSignOut() {
  await Promise.all(appModules.map((m) => m.beforeSignOut?.().catch(() => undefined)));
}
export const navigationGuards: AppNavigationGuard[] = appModules.flatMap((m) => m.navigationGuards ?? []);

const allWidgets: DashboardWidget[] = appModules.flatMap((m) => m.widgets ?? []);

/** Widgets registered for a slot, sorted; the host filters them by permission/plan module. */
export function widgetsFor<S extends WidgetSlot>(slot: S): DashboardWidget<S>[] {
  return (allWidgets.filter((w) => w.slot === slot) as DashboardWidget<S>[]).sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
  );
}
