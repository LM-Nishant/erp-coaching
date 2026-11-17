import { codeWorkingOutline, documentTextOutline, ribbonOutline, schoolOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'exams',
  routes: [
    // Staff
    {
      path: '/exams',
      name: 'exams',
      component: () => import('./ExamsPage.vue'),
      meta: { permission: 'exams.view' },
    },
    {
      path: '/exams/new',
      name: 'exam-new',
      component: () => import('./ExamFormPage.vue'),
      meta: { permission: 'exams.create' },
    },
    {
      path: '/exams/:id(\\d+)',
      name: 'exam-detail',
      component: () => import('./ExamDetailPage.vue'),
      meta: { permission: 'exams.view' },
    },
    {
      path: '/exams/:id(\\d+)/edit',
      name: 'exam-edit',
      component: () => import('./ExamFormPage.vue'),
      meta: { permission: 'exams.edit' },
    },
    {
      path: '/exams/:id(\\d+)/evaluate',
      name: 'exam-evaluate',
      component: () => import('./EvaluationPage.vue'),
      meta: { permission: 'exams.approve' },
    },
    {
      path: '/exams/:id(\\d+)/results',
      name: 'exam-results',
      component: () => import('./ExamResultsPage.vue'),
      meta: { permission: 'exams.view' },
    },
    {
      path: '/exams/:id(\\d+)/attempts/:attemptId(\\d+)',
      name: 'exam-attempt-result',
      component: () => import('./ResultPage.vue'),
      meta: { permission: 'exams.view' },
      props: { viewer: 'staff' },
    },
    {
      path: '/exams/prompts',
      name: 'exam-prompts',
      component: () => import('./PromptVersionsPage.vue'),
      meta: { permission: 'exams.configure' },
    },
    // Student
    {
      path: '/my-exams',
      name: 'my-exams',
      component: () => import('./MyExamsPage.vue'),
      meta: { permission: 'exam-portal.create' },
    },
    {
      path: '/my-exams/attempts/:attemptId(\\d+)',
      name: 'exam-take',
      component: () => import('./TakeExamPage.vue'),
      meta: { permission: 'exam-portal.create' },
    },
    // Students see their own published results; parents see their linked children's.
    {
      path: '/exam-results',
      name: 'exam-results-list',
      component: () => import('./ResultsListPage.vue'),
      meta: { permission: 'exam-portal.view' },
    },
    {
      path: '/exam-results/:attemptId(\\d+)',
      name: 'exam-result',
      component: () => import('./ResultPage.vue'),
      meta: { permission: 'exam-portal.view' },
    },
  ],
  menu: [
    {
      title: 'Exams',
      path: '/exams',
      icon: documentTextOutline,
      permission: 'exams.view',
      planModule: 'exams',
      order: 41,
    },
    {
      title: 'AI grading prompts',
      path: '/exams/prompts',
      icon: codeWorkingOutline,
      permission: 'exams.configure',
      planModule: 'exams',
      order: 42,
    },
    {
      title: 'My exams',
      path: '/my-exams',
      icon: schoolOutline,
      permission: 'exam-portal.create',
      planModule: 'exams',
      order: 41,
    },
    {
      title: 'Exam results',
      path: '/exam-results',
      icon: ribbonOutline,
      permission: 'exam-portal.view',
      planModule: 'exams',
      order: 42,
    },
  ],
});
