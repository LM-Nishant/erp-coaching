import { archiveOutline, trashBinOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

const admin = { superAdmin: true } as const;

export default defineAppModule({
  id: 'tenant-data',
  routes: [
    {
      path: '/data',
      name: 'tenant-data',
      component: () => import('./DataPage.vue'),
      // Data portability stays available while the subscription is suspended.
      meta: { permission: 'tenant-data.view', allowWhenSuspended: true },
    },
    {
      path: '/admin/data/deletion-requests',
      name: 'admin-data-deletion-requests',
      component: () => import('./admin/DeletionRequestsPage.vue'),
      meta: admin,
    },
    {
      path: '/admin/data/institutes/:id',
      name: 'admin-data-institute',
      component: () => import('./admin/InstituteDataPage.vue'),
      meta: admin,
    },
  ],
  menu: [
    {
      title: 'Data export & deletion',
      path: '/data',
      group: 'settings',
      titleKey: 'nav.tenantData.data',
      icon: archiveOutline,
      permission: 'tenant-data.view',
      order: 95,
    },
    {
      title: 'Data deletion',
      path: '/admin/data/deletion-requests',
      group: 'platform',
      titleKey: 'nav.tenantData.deletion',
      icon: trashBinOutline,
      superAdmin: true,
      order: 35,
    },
  ],
});
