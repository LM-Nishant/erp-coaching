import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'auth',
  publicRoutes: [
    { path: '/login', name: 'login', component: () => import('./LoginPage.vue') },
    { path: '/otp', name: 'otp', component: () => import('./OtpPage.vue') },
  ],
  routes: [
    {
      path: '/select-institute',
      name: 'select-institute',
      component: () => import('./SelectInstitutePage.vue'),
      meta: { allowWhenSuspended: true },
    },
    {
      path: '/forbidden',
      name: 'forbidden',
      component: () => import('./ForbiddenPage.vue'),
      meta: { allowWhenSuspended: true },
    },
  ],
});
