import { homeOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'dashboard',
  routes: [{ path: '/home', name: 'home', component: () => import('./DashboardPage.vue') }],
  menu: [
    {
      title: 'Home',
      path: '/home',
      group: 'home',
      titleKey: 'nav.dashboard.home',
      personas: ['student', 'teacher', 'staff', 'learner', 'platform'],
      tab: { student: 1, teacher: 1, staff: 1, platform: 1 },
      icon: homeOutline,
      order: 0,
    },
  ],
});
