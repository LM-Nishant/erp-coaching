import { radioOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'live-classes',
  routes: [
    {
      path: '/live-classes',
      name: 'live-classes',
      component: () => import('./LiveClassesPage.vue'),
      meta: { permission: 'live-classes.view' },
    },
    {
      path: '/live-classes/:id(\\d+)',
      name: 'live-class-detail',
      component: () => import('./LiveClassDetailPage.vue'),
      meta: { permission: 'live-classes.view' },
    },
    {
      path: '/live-classes/:id(\\d+)/room',
      name: 'live-class-room',
      component: () => import('./LiveRoomPage.vue'),
      meta: { permission: 'live-classes.view' },
    },
  ],
  menu: [
    {
      title: 'Live classes',
      path: '/live-classes',
      icon: radioOutline,
      permission: 'live-classes.view',
      planModule: 'live-classes',
      order: 35,
    },
  ],
});
