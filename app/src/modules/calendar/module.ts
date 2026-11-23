import { calendarOutline, logoGoogle } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'calendar',
  routes: [
    {
      path: '/calendar',
      name: 'calendar-settings',
      component: () => import('./CalendarSettingsPage.vue'),
      meta: { permission: 'institute.configure' },
    },
    {
      path: '/admin/calendar',
      name: 'admin-calendar',
      component: () => import('./PlatformCalendarPage.vue'),
      meta: { superAdmin: true },
    },
  ],
  menu: [
    {
      title: 'Calendar sync',
      path: '/calendar',
      group: 'settings',
      titleKey: 'nav.calendar.sync',
      icon: calendarOutline,
      permission: 'institute.configure',
      planModule: 'appointments',
      order: 59,
    },
    {
      title: 'Google Calendar',
      path: '/admin/calendar',
      group: 'platform',
      titleKey: 'nav.calendar.google',
      icon: logoGoogle,
      superAdmin: true,
      order: 33,
    },
  ],
});
