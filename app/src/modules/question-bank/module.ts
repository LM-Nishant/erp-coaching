import { libraryOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'question-bank',
  routes: [
    {
      path: '/question-bank',
      name: 'question-banks',
      component: () => import('./BanksPage.vue'),
      meta: { permission: 'question-bank.view' },
    },
    {
      path: '/question-bank/banks/:id(\\d+)',
      name: 'question-bank-detail',
      component: () => import('./BankDetailPage.vue'),
      meta: { permission: 'question-bank.view' },
    },
    {
      path: '/question-bank/banks/:bankId(\\d+)/questions/new',
      name: 'question-new',
      component: () => import('./QuestionEditorPage.vue'),
      meta: { permission: 'question-bank.create' },
    },
    {
      path: '/question-bank/questions/:id(\\d+)',
      name: 'question-edit',
      component: () => import('./QuestionEditorPage.vue'),
      meta: { permission: 'question-bank.view' },
    },
    {
      path: '/question-bank/banks/:bankId(\\d+)/generate',
      name: 'question-generate',
      component: () => import('./GenerateQuestionsPage.vue'),
      meta: { permission: 'question-bank.create' },
    },
    {
      path: '/question-bank/banks/:bankId(\\d+)/import-pdf',
      name: 'question-pdf-import',
      component: () => import('./PdfImportPage.vue'),
      meta: { permission: 'question-bank.create' },
    },
  ],
  menu: [
    {
      title: 'Question bank',
      path: '/question-bank',
      icon: libraryOutline,
      permission: 'question-bank.view',
      planModule: 'question-bank',
      order: 40,
    },
  ],
});
