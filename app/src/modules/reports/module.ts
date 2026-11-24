import { defineAsyncComponent } from 'vue';
import { analyticsOutline, barChartOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'reports',
  routes: [
    {
      path: '/reports',
      name: 'reports',
      component: () => import('./ReportsPage.vue'),
      meta: { permission: 'reports.view' },
    },
    {
      path: '/reports/exports',
      name: 'report-exports',
      component: () => import('./ExportsPage.vue'),
      meta: { permission: 'reports.export' },
    },
    {
      path: '/reports/platform',
      name: 'platform-reports',
      component: () => import('./PlatformReportsPage.vue'),
      meta: { superAdmin: true },
    },
    {
      path: '/reports/:key([a-z-]+)',
      name: 'report',
      component: () => import('./ReportPage.vue'),
      meta: { permission: 'reports.view' },
    },
  ],
  menu: [
    {
      title: 'Reports',
      path: '/reports',
      // Students and parents hold `reports.view` for their own report cards; the catalogue is for staff.
      personas: ['staff', 'teacher'],
      group: 'reports',
      titleKey: 'nav.reports.reports',
      icon: barChartOutline,
      permission: 'reports.view',
      planModule: 'reports',
      order: 85,
    },
    {
      title: 'Platform analytics',
      path: '/reports/platform',
      group: 'platform',
      titleKey: 'nav.reports.platform',
      tab: { platform: 4 },
      tabTitleKey: 'nav.tabs.analytics',
      icon: analyticsOutline,
      superAdmin: true,
      order: 15,
    },
  ],
  widgets: [
    {
      id: 'reports.role-dashboard',
      slot: 'home',
      title: 'Analytics',
      component: defineAsyncComponent(() => import('./widgets/RoleDashboardWidget.vue')),
      permission: 'reports.view',
      planModule: 'reports',
      order: 10,
      size: 'full',
    },
    {
      id: 'reports.platform-summary',
      slot: 'platform-home',
      title: 'Platform analytics · this month',
      component: defineAsyncComponent(() => import('./widgets/PlatformSummaryWidget.vue')),
      order: 10,
      size: 'full',
    },
  ],
});
