import { defineAsyncComponent } from 'vue';
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
      group: 'classes',
      titleKey: 'nav.liveClasses.liveClasses',
      tab: { student: 2, teacher: 7 },
      tabTitleKey: 'nav.tabs.classes',
      icon: radioOutline,
      permission: 'live-classes.view',
      planModule: 'live-classes',
      order: 35,
    },
  ],
  widgets: [
    {
      id: 'live-classes.next',
      slot: 'student-home',
      title: 'Next class',
      component: defineAsyncComponent(() => import('./widgets/NextClassWidget.vue')),
      permission: 'live-classes.view',
      planModule: 'live-classes',
      order: 10,
      size: 'full',
    },
  ],
});
