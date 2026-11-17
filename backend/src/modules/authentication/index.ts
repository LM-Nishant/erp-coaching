import { defineModule } from '../../shared/module';
import { associateAuthModels, initAuthModels } from './models';
import { authRoutes } from './auth.routes';

export default defineModule({
  name: 'authentication',
  models: initAuthModels,
  associate: associateAuthModels,
  routes: authRoutes,
});
