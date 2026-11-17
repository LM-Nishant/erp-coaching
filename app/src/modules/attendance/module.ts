import {
  calendarOutline,
  checkmarkDoneOutline,
  documentTextOutline,
  qrCodeOutline,
  settingsOutline,
  statsChartOutline,
} from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'attendance',
  routes: [
    {
      path: '/attendance',
      name: 'attendance-day',
      component: () => import('./AttendanceDayPage.vue'),
      meta: { permission: 'attendance.create' },
    },
    {
      path: '/attendance/sessions/:id(\\d+)',
      name: 'attendance-roster',
      component: () => import('./RosterPage.vue'),
      meta: { permission: 'attendance.view' },
    },
    {
      path: '/attendance/sessions/:id(\\d+)/qr',
      name: 'attendance-qr',
      component: () => import('./QrDisplayPage.vue'),
      meta: { permission: 'attendance.create' },
    },
    {
      path: '/attendance/requests',
      name: 'attendance-requests',
      component: () => import('./RequestsPage.vue'),
      meta: { permission: 'attendance.view' },
    },
    {
      path: '/attendance/reports',
      name: 'attendance-reports',
      component: () => import('./ReportsPage.vue'),
      meta: { permission: 'attendance.view' },
    },
    {
      path: '/attendance/settings',
      name: 'attendance-settings',
      component: () => import('./AttendanceSettingsPage.vue'),
      meta: { permission: 'attendance.configure' },
    },
    {
      path: '/attendance/check-in',
      name: 'attendance-check-in',
      component: () => import('./CheckInPage.vue'),
      meta: { permission: 'attendance-self.create' },
    },
    {
      path: '/attendance/my',
      name: 'attendance-my',
      component: () => import('./MyAttendancePage.vue'),
      meta: { permission: 'attendance-self.view' },
    },
  ],
  menu: [
    {
      title: 'Take attendance',
      path: '/attendance',
      icon: checkmarkDoneOutline,
      permission: 'attendance.create',
      planModule: 'attendance',
      order: 30,
    },
    {
      title: 'Attendance requests',
      path: '/attendance/requests',
      icon: documentTextOutline,
      permission: 'attendance.view',
      planModule: 'attendance',
      order: 31,
    },
    {
      title: 'Attendance reports',
      path: '/attendance/reports',
      icon: statsChartOutline,
      permission: 'attendance.view',
      planModule: 'attendance',
      order: 32,
    },
    {
      title: 'Attendance setup',
      path: '/attendance/settings',
      icon: settingsOutline,
      permission: 'attendance.configure',
      planModule: 'attendance',
      order: 33,
    },
    {
      title: 'Check in',
      path: '/attendance/check-in',
      icon: qrCodeOutline,
      permission: 'attendance-self.create',
      planModule: 'attendance',
      order: 30,
    },
    {
      title: 'My attendance',
      path: '/attendance/my',
      icon: calendarOutline,
      permission: 'attendance-self.view',
      planModule: 'attendance',
      order: 31,
    },
  ],
});
