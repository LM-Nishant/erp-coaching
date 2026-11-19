import { phonePortraitOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'users',
  routes: [
    {
      path: '/users/devices',
      name: 'member-devices',
      component: () => import('./MemberDevicesPage.vue'),
      // Uses /users/devices and /users/:id/devices only, which the API allows while suspended, so
      // admins can still sign out a member's lost device.
      meta: { permission: 'users.view', allowWhenSuspended: true },
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
