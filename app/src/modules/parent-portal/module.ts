import { defineAsyncComponent } from 'vue';
import { documentTextOutline, homeOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

/**
 * Parent home: a per-child dashboard assembled from `widgets` with slot `parent-home` contributed by
 * any app module (see CONTRIBUTING "Dashboard widgets"). The cards below are the built-in ones.
 */
export default defineAppModule({
  id: 'parent-portal',
  routes: [
    {
      path: '/parent-home',
      name: 'parent-home',
      component: () => import('./ParentHomePage.vue'),
      meta: { permission: 'parent-portal.view' },
    },
    {
      path: '/parent-home/reports',
      name: 'parent-monthly-reports',
      component: () => import('./MonthlyReportsPage.vue'),
      meta: { permission: 'parent-portal.view' },
    },
  ],
  menu: [
    {
      title: 'Home',
      path: '/parent-home',
      group: 'home',
      titleKey: 'nav.parentPortal.home',
      tab: { parent: 1 },
      icon: homeOutline,
      permission: 'parent-portal.view',
      planModule: 'parent-portal',
      order: 1,
    },
    {
      title: 'Monthly reports',
      path: '/parent-home/reports',
      group: 'reports',
      titleKey: 'nav.parentPortal.monthlyReports',
      icon: documentTextOutline,
      permission: 'parent-portal.view',
      planModule: 'parent-portal',
      order: 2,
    },
  ],
  widgets: [
    {
      id: 'parent-portal.schedule',
      slot: 'parent-home',
      title: 'This week’s classes',
      component: defineAsyncComponent(() => import('./widgets/ScheduleWidget.vue')),
      planModule: 'academics',
      order: 10,
      size: 'full',
    },
    {
      id: 'parent-portal.summary',
      slot: 'parent-home',
      title: 'At a glance',
      component: defineAsyncComponent(() => import('./widgets/SummaryWidget.vue')),
      order: 20,
      size: 'full',
    },
    {
      id: 'parent-portal.notifications',
      slot: 'parent-home',
      title: 'Recent notifications',
      component: defineAsyncComponent(() => import('./widgets/NotificationsWidget.vue')),
      permission: 'notification-inbox.view',
      order: 30,
    },
    {
      id: 'parent-portal.grievances',
      slot: 'parent-home',
      title: 'Complaints & requests',
      component: defineAsyncComponent(() => import('./widgets/GrievancesWidget.vue')),
      permission: 'grievances.view',
      planModule: 'grievances',
      order: 50,
    },
  ],
});
