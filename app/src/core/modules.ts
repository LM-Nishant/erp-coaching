import type { Component } from 'vue';
import type { RouteRecordRaw } from 'vue-router';
import type { PermissionKey } from '@erp/shared';

export interface MenuItem {
  title: string;
  path: string;
  /** ionicons icon (import from 'ionicons/icons'). */
  icon: string;
  /** Shown only when the user has this permission. */
  permission?: PermissionKey;
  /** Platform (super admin, not impersonating) menu. */
  superAdmin?: boolean;
  /** Hidden when the institute's plan doesn't enable this module id (backend `requireModule`). */
  planModule?: string;
  /** Lower comes first. Default 100. */
  order?: number;
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
}

export function defineAppModule(m: AppModule): AppModule {
  return m;
}

/**
 * Auto-discovers every `src/modules/<name>/module.ts`. A new feature module only adds its own folder —
 * no edits to the router, menu or App.vue are needed.
 */
export const appModules: AppModule[] = Object.values(
  import.meta.glob<{ default: AppModule }>('../modules/*/module.ts', { eager: true }),
).map((m) => m.default);

export const toolbarItems: Component[] = appModules.flatMap((m) => m.toolbarItems ?? []);
