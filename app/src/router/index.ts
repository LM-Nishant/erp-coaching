import { createRouter, createWebHistory } from '@ionic/vue-router';
import type { RouteLocationNormalized, RouteRecordRaw } from 'vue-router';
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
    /** Stays reachable while the institute's subscription is suspended (billing, data export). */
    allowWhenSuspended?: boolean;
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

router.beforeEach(async (to: RouteLocationNormalized) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.init();
  if (to.meta.public) {
    if (auth.isAuthenticated && !auth.needsInstitute && to.name === 'login') return '/home';
    return true;
  }
  if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } };
  if (auth.needsInstitute && to.name !== 'select-institute') return { name: 'select-institute' };
  if (to.meta.superAdmin && !auth.isPlatformAdmin) return '/home';
  if (to.meta.permission && !auth.can(to.meta.permission)) return { name: 'forbidden' };
  for (const guard of navigationGuards) {
    const result = await guard(to);
    if (result !== true) return result;
  }
  return true;
});
