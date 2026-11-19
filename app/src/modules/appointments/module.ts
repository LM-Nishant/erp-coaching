import { defineAsyncComponent } from 'vue';
import { barChartOutline, calendarClearOutline, chatbubblesOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'appointments',
  routes: [
    {
      path: '/appointments',
      name: 'appointments',
      component: () => import('./AppointmentsPage.vue'),
      meta: { permission: 'appointments.view' },
    },
    {
      path: '/appointments/request',
      name: 'appointments-request',
      component: () => import('./RequestMeetingPage.vue'),
      meta: { permission: 'appointments.create' },
    },
    {
      path: '/appointments/availability',
      name: 'appointments-availability',
      component: () => import('./AvailabilityPage.vue'),
      meta: { permission: 'appointments.edit' },
    },
    {
      path: '/appointments/reports',
      name: 'appointments-reports',
      component: () => import('./AppointmentReportsPage.vue'),
      meta: { permission: 'appointments.export' },
    },
    {
      path: '/appointments/:id(\\d+)',
      name: 'appointment-detail',
      component: () => import('./AppointmentDetailPage.vue'),
      meta: { permission: 'appointments.view' },
    },
  ],
  menu: [
    {
      title: 'Parent meetings',
      path: '/appointments',
      icon: chatbubblesOutline,
      permission: 'appointments.view',
      planModule: 'appointments',
      order: 56,
    },
    {
      title: 'My availability',
      path: '/appointments/availability',
      icon: calendarClearOutline,
      permission: 'appointments.edit',
      // Only teachers have slots; managers hold `edit` to manage meetings.
      roles: ['teacher'],
      planModule: 'appointments',
      order: 57,
    },
    {
      title: 'Meeting reports',
      path: '/appointments/reports',
      icon: barChartOutline,
      permission: 'appointments.export',
      planModule: 'appointments',
      order: 58,
    },
  ],
  widgets: [
    {
      id: 'appointments.upcoming',
      slot: 'parent-home',
      title: 'Teacher meetings',
      component: defineAsyncComponent(() => import('./components/ParentAppointmentsWidget.vue')),
      permission: 'appointments.view',
      planModule: 'appointments',
      order: 40,
    },
  ],
});
