import { extensionPuzzleOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'platform',
  routes: [
    {
      path: '/admin/platform',
      name: 'admin-platform',
      component: () => import('./IntegrationsPage.vue'),
      meta: { superAdmin: true },
    },
  ],
  menu: [
    {
      title: 'Integrations',
      path: '/admin/platform',
      group: 'platform',
      titleKey: 'nav.platform.integrations',
      icon: extensionPuzzleOutline,
      superAdmin: true,
      order: 32,
    },
  ],
});
