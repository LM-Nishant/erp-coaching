import { businessOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'institute',
  routes: [
    {
      path: '/institute',
      name: 'institute-profile',
      component: () => import('./InstituteProfilePage.vue'),
      meta: { permission: 'institute.configure' },
    },
  ],
  menu: [
    {
      title: 'Institute profile',
      path: '/institute',
      icon: businessOutline,
      permission: 'institute.configure',
      order: 90,
    },
  ],
});
