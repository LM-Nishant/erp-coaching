import { defineModule } from '../../shared/module';
import { initAiModels } from './models';
import { aiRoutes } from './ai.routes';

export default defineModule({
  name: 'ai',
  models: initAiModels,
  routes: aiRoutes,
  permissions: [
    {
      module: 'ai',
      label: 'AI usage',
      area: 'Institute',
      describe: { view: ['View AI usage', "See the institute's AI credits and usage"] },
      actions: ['view'],
      grants: { 'branch-admin': ['view'] },
    },
  ],
});
