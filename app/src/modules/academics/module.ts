import {
  calendarOutline,
  libraryOutline,
  peopleOutline,
  schoolOutline,
  timeOutline,
  businessOutline,
} from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';
import type { PermissionKey } from '@erp/shared';

const meta = (permission: PermissionKey) => ({ permission });

export default defineAppModule({
  id: 'academics',
  routes: [
    {
      path: '/academics/sessions',
      name: 'academic-sessions',
      component: () => import('./AcademicSessionsPage.vue'),
      meta: meta('academics.view'),
    },
    {
      path: '/academics/courses',
      name: 'academic-courses',
      component: () => import('./CoursesPage.vue'),
      meta: meta('academics.view'),
    },
    {
      path: '/academics/syllabus',
      name: 'academic-syllabus',
      component: () => import('./SyllabusPage.vue'),
      meta: meta('academics.view'),
    },
    {
      path: '/academics/batches',
      name: 'academic-batches',
      component: () => import('./BatchesPage.vue'),
      meta: meta('academics.view'),
    },
    {
      path: '/academics/classrooms',
      name: 'academic-classrooms',
      component: () => import('./ClassroomsPage.vue'),
      meta: meta('academics.view'),
    },
    {
      path: '/academics/timetable',
      name: 'academic-timetable',
      component: () => import('./TimetablePage.vue'),
      meta: meta('academics.view'),
    },
    {
      path: '/academics/classes/:id',
      name: 'academic-class',
      component: () => import('./ClassSessionPage.vue'),
      meta: meta('academics.view'),
    },
    {
      path: '/my-timetable',
      name: 'my-timetable',
      component: () => import('./MyTimetablePage.vue'),
      meta: meta('academics.view'),
    },
  ],
  menu: [
    {
      title: 'My timetable',
      path: '/my-timetable',
      icon: calendarOutline,
      permission: 'academics.view',
      roles: ['teacher', 'student'],
      planModule: 'academics',
      order: 30,
    },
    {
      title: 'Academic sessions',
      path: '/academics/sessions',
      icon: timeOutline,
      permission: 'academics.create',
      planModule: 'academics',
      order: 40,
    },
    {
      title: 'Courses',
      path: '/academics/courses',
      icon: schoolOutline,
      permission: 'academics.view',
      planModule: 'academics',
      order: 41,
    },
    {
      title: 'Syllabus',
      path: '/academics/syllabus',
      icon: libraryOutline,
      permission: 'academics.view',
      planModule: 'academics',
      order: 42,
    },
    {
      title: 'Batches',
      path: '/academics/batches',
      icon: peopleOutline,
      permission: 'academics.view',
      planModule: 'academics',
      order: 43,
    },
    {
      title: 'Classrooms',
      path: '/academics/classrooms',
      icon: businessOutline,
      permission: 'academics.create',
      planModule: 'academics',
      order: 44,
    },
    {
      title: 'Timetable',
      path: '/academics/timetable',
      icon: calendarOutline,
      permission: 'academics.create',
      planModule: 'academics',
      order: 45,
    },
  ],
});
