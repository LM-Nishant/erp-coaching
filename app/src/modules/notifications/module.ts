import { defineAsyncComponent } from 'vue';
import { megaphoneOutline, notificationsOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';

export default defineAppModule({
  id: 'notifications',
  routes: [
    {
      path: '/notifications',
      name: 'notifications-inbox',
      component: () => import('./InboxPage.vue'),
      // Institute members need the permission; users without an institute read their personal inbox.
      beforeEnter: () => {
        const auth = useAuthStore();
        return auth.personalInbox || auth.can('notification-inbox.view') || { name: 'forbidden' };
      },
    },
    {
      path: '/notifications/preferences',
      name: 'notifications-preferences',
      component: () => import('./PreferencesPage.vue'),
      meta: { permission: 'notification-inbox.edit' },
    },
    {
      path: '/communication',
      name: 'communication',
      component: () => import('./CommunicationPage.vue'),
      meta: { permission: 'notifications.view' },
    },
  ],
  menu: [
    {
      title: 'Communication',
      path: '/communication',
      icon: megaphoneOutline,
      permission: 'notifications.view',
      order: 70,
    },
    {
      title: 'Notifications',
      path: '/notifications',
      icon: notificationsOutline,
      permission: 'notification-inbox.view',
      order: 90,
    },
    {
      title: 'Notifications',
      path: '/notifications',
      icon: notificationsOutline,
      visible: () => useAuthStore().personalInbox,
      order: 90,
    },
  ],
  toolbarItems: [defineAsyncComponent(() => import('./components/NotificationBell.vue'))],
  beforeSignOut: async () => (await import('./push')).unregisterPush(),
});
