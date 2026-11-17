import { homeOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'dashboard',
  routes: [{ path: '/home', name: 'home', component: () => import('./DashboardPage.vue') }],
  menu: [{ title: 'Dashboard', path: '/home', icon: homeOutline, order: 0 }],
});
