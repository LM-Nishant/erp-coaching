import { defineAsyncComponent } from 'vue';
import { chatbubblesOutline, helpCircleOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

// Doubts are part of the learning experience, so they follow the institute's LMS plan module.
const PLAN = 'lms';
const teacherCard = defineAsyncComponent(() => import('./widgets/TeacherDoubtsWidget.vue'));
const studentCard = defineAsyncComponent(() => import('./widgets/StudentDoubtsWidget.vue'));

export default defineAppModule({
  id: 'doubts',
  routes: [
    {
      path: '/doubts',
      name: 'doubts-mine',
      component: () => import('./MyDoubtsPage.vue'),
      meta: { permission: 'doubts.create' },
    },
    {
      path: '/doubts/ask',
      name: 'doubts-ask',
      component: () => import('./AskDoubtPage.vue'),
      meta: { permission: 'doubts.create' },
    },
    {
      path: '/doubts/inbox',
      name: 'doubts-inbox',
      component: () => import('./DoubtInboxPage.vue'),
      meta: { permission: 'doubts.edit' },
    },
    {
      path: '/doubts/:id(\\d+)',
      name: 'doubt-detail',
      component: () => import('./DoubtDetailPage.vue'),
      meta: { permission: 'doubts.view' },
    },
  ],
  menu: [
    {
      title: 'My doubts',
      path: '/doubts',
      group: 'learning',
      titleKey: 'nav.doubts.mine',
      icon: helpCircleOutline,
      permission: 'doubts.create',
      planModule: PLAN,
      order: 45,
    },
    {
      title: 'Doubt inbox',
      path: '/doubts/inbox',
      group: 'learning',
      titleKey: 'nav.doubts.inbox',
      icon: chatbubblesOutline,
      permission: 'doubts.edit',
      planModule: PLAN,
      order: 45,
    },
  ],
  widgets: [
    {
      id: 'doubts.inbox',
      slot: 'teacher-home',
      title: 'Doubts to answer',
      component: teacherCard,
      permission: 'doubts.edit',
      planModule: PLAN,
      order: 30,
    },
    {
      id: 'doubts.mine',
      slot: 'student-home',
      title: 'My doubts',
      component: studentCard,
      permission: 'doubts.create',
      planModule: PLAN,
      order: 30,
    },
    // The generic dashboard, until every persona has its own home.
    {
      id: 'doubts.inboxHome',
      slot: 'home',
      title: 'Doubts to answer',
      component: teacherCard,
      permission: 'doubts.edit',
      planModule: PLAN,
      order: 30,
    },
    {
      id: 'doubts.mineHome',
      slot: 'home',
      title: 'My doubts',
      component: studentCard,
      permission: 'doubts.create',
      planModule: PLAN,
      order: 30,
    },
  ],
});
