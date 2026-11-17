import { idCardOutline, peopleOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'students',
  routes: [
    {
      path: '/students',
      name: 'students',
      component: () => import('./StudentsPage.vue'),
      meta: { permission: 'students.view' },
    },
    {
      path: '/students/settings',
      name: 'student-settings',
      component: () => import('./StudentSettingsPage.vue'),
      meta: { permission: 'students.configure' },
    },
    {
      path: '/students/:id(\\d+)',
      name: 'student-profile',
      component: () => import('./StudentProfilePage.vue'),
      meta: { permission: 'students.view' },
    },
    {
      path: '/my-profile',
      name: 'my-profile',
      component: () => import('./MyProfilePage.vue'),
      meta: { permission: 'student-portal.view' },
    },
  ],
  publicRoutes: [
    { path: '/register/:slug', name: 'register', component: () => import('./RegisterPage.vue') },
  ],
  menu: [
    { title: 'Students', path: '/students', icon: peopleOutline, permission: 'students.view', order: 30 },
    {
      title: 'My profile',
      path: '/my-profile',
      icon: idCardOutline,
      permission: 'student-portal.view',
      order: 15,
    },
  ],
});
