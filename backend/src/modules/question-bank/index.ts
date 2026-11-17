import { defineModule } from '../../shared/module';
import { associateQuestionBankModels, initQuestionBankModels } from './models';
import { questionBankRoutes } from './question-bank.routes';

export default defineModule({
  name: 'question-bank',
  models: initQuestionBankModels,
  associate: associateQuestionBankModels,
  routes: questionBankRoutes,
  permissions: [
    {
      module: 'question-bank',
      label: 'Question bank',
      actions: ['view', 'create', 'edit', 'delete', 'export', 'configure'],
      grants: {
        'branch-admin': 'all',
        teacher: ['view', 'create', 'edit', 'delete', 'export'],
      },
    },
  ],
});
