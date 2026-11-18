import { defineModule } from '../../shared/module';
import { initPlatformModels } from './models';
import { platformRoutes } from './platform.routes';
import { registerPlatformIntegrations } from './integrations';

/** Super admin global configuration: SaaS payment gateways, notification providers and storage. */
export default defineModule({
  name: 'platform',
  models: initPlatformModels,
  routes: platformRoutes,
  onReady: registerPlatformIntegrations,
});
