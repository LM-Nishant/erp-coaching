import {
  cartOutline,
  checkmarkDoneCircleOutline,
  easelOutline,
  pricetagsOutline,
  receiptOutline,
  schoolOutline,
  settingsOutline,
  storefrontOutline,
  walletOutline,
} from 'ionicons/icons';
import type { RouteRecordRaw } from 'vue-router';
import { defineAppModule } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';

/** Seller pages, once for an independent instructor and once for an institute's storefront (permission-guarded). */
function studioRoutes(scope: 'instructor' | 'institute'): RouteRecordRaw[] {
  const meta = (action: 'view' | 'edit' | 'configure') =>
    scope === 'institute' ? { permission: `marketplace.${action}` as const } : {};
  const base = `/market/studio/:scope(${scope})`;
  return [
    {
      path: base,
      name: `market-studio-${scope}`,
      component: () => import('./studio/StudioPage.vue'),
      meta: meta('view'),
    },
    {
      path: `${base}/courses/:id(\\d+)`,
      name: `market-builder-${scope}`,
      component: () => import('./studio/CourseBuilderPage.vue'),
      meta: meta('edit'),
    },
    {
      path: `${base}/coupons`,
      name: `market-coupons-${scope}`,
      component: () => import('./studio/CouponsPage.vue'),
      meta: meta('configure'),
    },
    {
      path: `${base}/sales`,
      name: `market-sales-${scope}`,
      component: () => import('./studio/SalesPage.vue'),
      meta: meta('view'),
    },
  ];
}

export default defineAppModule({
  id: 'marketplace',
  // `shell`: public pages that keep the side menu for signed-in users.
  publicRoutes: [
    {
      path: '/market',
      name: 'market-home',
      component: () => import('./MarketHomePage.vue'),
      meta: { shell: true },
    },
    {
      path: '/market/search',
      name: 'market-search',
      component: () => import('./SearchPage.vue'),
      meta: { shell: true },
    },
    {
      path: '/market/course/:slug',
      name: 'market-course',
      component: () => import('./CourseLandingPage.vue'),
      meta: { shell: true },
    },
    {
      path: '/market/instructor/:slug',
      name: 'market-instructor',
      component: () => import('./InstructorPage.vue'),
      meta: { shell: true },
    },
    {
      path: '/market/certificates/:code',
      name: 'market-certificate',
      component: () => import('./CertificatePage.vue'),
      meta: { shell: true },
    },
    { path: '/market/signup', name: 'market-signup', component: () => import('./SignupPage.vue') },
  ],
  routes: [
    { path: '/market/teach', name: 'market-teach', component: () => import('./TeachPage.vue') },
    { path: '/market/cart', name: 'market-cart', component: () => import('./CartPage.vue') },
    { path: '/market/orders', name: 'market-orders', component: () => import('./OrdersPage.vue') },
    { path: '/market/orders/:id(\\d+)', name: 'market-order', component: () => import('./OrderPage.vue') },
    { path: '/market/learning', name: 'market-learning', component: () => import('./MyLearningPage.vue') },
    { path: '/market/learn/:id(\\d+)', name: 'market-player', component: () => import('./PlayerPage.vue') },
    ...studioRoutes('instructor'),
    ...studioRoutes('institute'),
    {
      path: '/admin/marketplace/reviews',
      name: 'market-admin-reviews',
      component: () => import('./admin/ReviewQueuePage.vue'),
      meta: { superAdmin: true },
    },
    {
      path: '/admin/marketplace/courses/:id(\\d+)',
      name: 'market-admin-course',
      component: () => import('./admin/ReviewCoursePage.vue'),
      meta: { superAdmin: true },
    },
    {
      path: '/admin/marketplace/settings',
      name: 'market-admin-settings',
      component: () => import('./admin/SettingsPage.vue'),
      meta: { superAdmin: true },
    },
    {
      path: '/admin/marketplace/coupons',
      name: 'market-admin-coupons',
      component: () => import('./studio/CouponsPage.vue'),
      meta: { superAdmin: true },
    },
    {
      path: '/admin/marketplace/sales',
      name: 'market-admin-sales',
      component: () => import('./studio/SalesPage.vue'),
      meta: { superAdmin: true },
    },
  ],
  menu: [
    { title: 'Course marketplace', path: '/market', icon: storefrontOutline, order: 150 },
    { title: 'My learning', path: '/market/learning', icon: schoolOutline, order: 151 },
    { title: 'Cart', path: '/market/cart', icon: cartOutline, order: 152 },
    { title: 'Purchase history', path: '/market/orders', icon: receiptOutline, order: 153 },
    { title: 'Teach on the marketplace', path: '/market/studio/instructor', icon: easelOutline, order: 154 },
    {
      title: 'Marketplace storefront',
      path: '/market/studio/institute',
      icon: storefrontOutline,
      permission: 'marketplace.view',
      order: 45,
    },
    {
      title: 'Course reviews',
      path: '/admin/marketplace/reviews',
      icon: checkmarkDoneCircleOutline,
      superAdmin: true,
      order: 60,
    },
    {
      title: 'Marketplace sales',
      path: '/admin/marketplace/sales',
      icon: walletOutline,
      superAdmin: true,
      order: 61,
    },
    {
      title: 'Platform coupons',
      path: '/admin/marketplace/coupons',
      icon: pricetagsOutline,
      superAdmin: true,
      order: 62,
    },
    {
      title: 'Marketplace settings',
      path: '/admin/marketplace/settings',
      icon: settingsOutline,
      superAdmin: true,
      order: 63,
    },
  ],
  navigationGuards: [
    // Learners who signed up on the marketplace belong to no institute: their home is the marketplace.
    (to) => {
      const auth = useAuthStore();
      if (to.path === '/home' && auth.me && !auth.me.institute && !auth.me.user.isSuperAdmin)
        return '/market/learning';
      return true;
    },
  ],
});
