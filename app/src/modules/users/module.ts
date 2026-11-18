import { phonePortraitOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'users',
  routes: [
    {
      path: '/users/devices',
      name: 'member-devices',
      component: () => import('./MemberDevicesPage.vue'),
      meta: { permission: 'users.view' },
    },
  ],
  menu: [
    {
      title: 'Member devices',
      path: '/users/devices',
      icon: phonePortraitOutline,
      permission: 'users.view',
      order: 92,
    },
  ],
});
