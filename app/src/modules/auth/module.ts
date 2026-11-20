import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'auth',
  publicRoutes: [
    // Signing in and unlocking must work while the subscription is suspended (the API allows /auth).
    {
      path: '/login',
      name: 'login',
      component: () => import('./LoginPage.vue'),
      meta: { allowWhenSuspended: true },
    },
    {
      path: '/otp',
      name: 'otp',
      component: () => import('./OtpPage.vue'),
      meta: { allowWhenSuspended: true },
    },
    // "Who's signing in?" after an OTP to a number several accounts sign in with (also "Switch profile").
    {
      path: '/choose-profile',
      name: 'choose-profile',
      component: () => import('./ChooseProfilePage.vue'),
      meta: { allowWhenSuspended: true },
    },
    // App locked (inactivity / closed session) with biometric unlock set up.
    {
      path: '/unlock',
      name: 'unlock',
      component: () => import('./UnlockPage.vue'),
      meta: { allowWhenSuspended: true },
    },
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
