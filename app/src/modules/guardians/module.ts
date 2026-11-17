import { happyOutline, peopleCircleOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'guardians',
  routes: [
    {
      path: '/guardians',
      name: 'guardians',
      component: () => import('./GuardiansPage.vue'),
      meta: { permission: 'guardians.view' },
    },
    {
      path: '/my-children',
      name: 'my-children',
      component: () => import('./MyChildrenPage.vue'),
      meta: { permission: 'guardian-portal.view' },
    },
    {
      path: '/my-children/:id(\\d+)',
      name: 'my-child',
      component: () => import('./ChildPage.vue'),
      meta: { permission: 'guardian-portal.view' },
    },
  ],
  menu: [
    {
      title: 'Guardians',
      path: '/guardians',
      icon: peopleCircleOutline,
      permission: 'guardians.view',
      order: 31,
    },
    {
      title: 'My children',
      path: '/my-children',
      icon: happyOutline,
      permission: 'guardian-portal.view',
      order: 15,
    },
  ],
});
