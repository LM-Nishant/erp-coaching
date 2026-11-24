import { phonePortraitOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'account',
  routes: [
    {
      path: '/account/devices',
      name: 'devices',
      component: () => import('./DevicesPage.vue'),
      // Uses /auth/devices only: signing out a lost device must work while the subscription is suspended.
      meta: { allowWhenSuspended: true },
    },
  ],
  menu: [
    {
      title: 'My devices',
      path: '/account/devices',
      group: 'settings',
      titleKey: 'nav.account.myDevices',
      icon: phonePortraitOutline,
      order: 200,
    },
  ],
});
