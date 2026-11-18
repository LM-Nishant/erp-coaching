import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'auth',
  publicRoutes: [
    { path: '/login', name: 'login', component: () => import('./LoginPage.vue') },
    { path: '/otp', name: 'otp', component: () => import('./OtpPage.vue') },
    // App locked (inactivity / closed session) with biometric unlock set up.
    { path: '/unlock', name: 'unlock', component: () => import('./UnlockPage.vue') },
  ],
  routes: [
    {
      path: '/select-institute',
      name: 'select-institute',
      component: () => import('./SelectInstitutePage.vue'),
    },
    { path: '/forbidden', name: 'forbidden', component: () => import('./ForbiddenPage.vue') },
  ],
});
