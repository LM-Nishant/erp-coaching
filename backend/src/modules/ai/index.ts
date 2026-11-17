import { defineModule } from '../../shared/module';
import { initAiModels } from './models';
import { aiRoutes } from './ai.routes';

export default defineModule({
  name: 'ai',
  models: initAiModels,
  routes: aiRoutes,
  permissions: [{ module: 'ai', label: 'AI usage', actions: ['view'], grants: { 'branch-admin': ['view'] } }],
});
