import { createRouter, createWebHistory } from '@ionic/vue-router';
import type {
  RouteLocation,
  RouteLocationNormalized,
  RouteRecordNormalized,
  RouteRecordRaw,
} from 'vue-router';
import type { PermissionKey } from '@erp/shared';
import { appModules, navigationGuards } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without login. */
    public?: boolean;
    /** Required permission (`module.action`). */
    permission?: PermissionKey;
    /** Platform super-admin page (not while impersonating). */
    superAdmin?: boolean;
    /**
     * Works without network in the mobile app. While offline (signed in from the cached profile) only these pages
     * open; a function decides per location (e.g. `?offline=1`).
     */
    offline?: boolean | ((to: RouteLocation) => boolean);
    /** Stays reachable while the institute's subscription is suspended (billing, data export). */
    allowWhenSuspended?: boolean;
    /** Public page that keeps the side menu for signed-in users (e.g. the course marketplace). */
    shell?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/home' },
  ...appModules.flatMap((m) =>
    (m.publicRoutes ?? []).map((r) => ({ ...r, meta: { ...r.meta, public: true } })),
  ),
  ...appModules.flatMap((m) => m.routes ?? []),
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/components/NotFoundPage.vue'),
    meta: { public: true },
  },
];

export const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes });

export const worksOffline = (to: RouteLocation) =>
  typeof to.meta.offline === 'function' ? to.meta.offline(to) : !!to.meta.offline;

/** Landing page in offline mode: the first page without parameters that works offline and the user may open. */
function offlineHome(): string | null {
  const auth = useAuthStore();
  const route = router
    .getRoutes()
    .find(
      (r: RouteRecordNormalized) =>
        r.meta.offline === true &&
        !r.path.includes(':') &&
        (!r.meta.permission || auth.can(r.meta.permission)),
    );
  return route?.path ?? null;
}

router.beforeEach(async (to: RouteLocationNormalized) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.init();
  if (to.name === 'unlock') {
    if (auth.isAuthenticated) return '/home';
    return auth.canUnlock ? true : { name: 'login', query: to.query };
  }
  if (to.meta.public) {
    if (auth.isAuthenticated && !auth.needsInstitute && to.name === 'login') return '/home';
    return true;
  }
  if (!auth.isAuthenticated)
    return { name: auth.canUnlock ? 'unlock' : 'login', query: { redirect: to.fullPath } };
  if (auth.needsInstitute && to.name !== 'select-institute') return { name: 'select-institute' };
  if (auth.offline && !worksOffline(to)) {
    const home = offlineHome();
    if (home && home !== to.path) return home;
  }
  // Parents land on their children's home (their "Home" tab), not the staff dashboard.
  if (
    to.path === '/home' &&
    auth.persona === 'parent' &&
    !auth.offline &&
    auth.can('parent-portal.view') &&
    auth.moduleEnabled('parent-portal')
  )
    return { path: '/parent-home', replace: true };
  if (to.meta.superAdmin && !auth.isPlatformAdmin) return '/home';
  if (to.meta.permission && !auth.can(to.meta.permission)) return { name: 'forbidden' };
  for (const guard of navigationGuards) {
    const result = await guard(to);
    if (result !== true) return result;
  }
  return true;
});
