import { phonePortraitOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'account',
  routes: [{ path: '/account/devices', name: 'devices', component: () => import('./DevicesPage.vue') }],
  menu: [{ title: 'My devices', path: '/account/devices', icon: phonePortraitOutline, order: 200 }],
});
