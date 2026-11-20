import { shieldCheckmarkOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'permissions',
  routes: [
    {
      path: '/roles',
      name: 'roles',
      component: () => import('./RolesPage.vue'),
      meta: { permission: 'roles.view' },
    },
  ],
  menu: [
    {
      title: 'Roles & permissions',
      path: '/roles',
      icon: shieldCheckmarkOutline,
      permission: 'roles.view',
      order: 93,
    },
  ],
});
