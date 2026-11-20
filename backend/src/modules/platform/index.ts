import { registerEncryptedColumns } from '../../infrastructure/database/encrypted-columns';
import { defineModule } from '../../shared/module';
import { initPlatformModels, PlatformIntegration } from './models';
import { platformRoutes } from './platform.routes';
import { rekeyTestedFingerprints } from './platform.service';
import { registerPlatformIntegrations } from './integrations';

/** Super admin global configuration: SaaS payment gateways, notification providers and storage. */
export default defineModule({
  name: 'platform',
  models: (sequelize) => {
    initPlatformModels(sequelize);
    registerEncryptedColumns(PlatformIntegration, ['secretsEncrypted'], {
      afterReencrypt: async () => void (await rekeyTestedFingerprints()),
    });
  },
  routes: platformRoutes,
  onReady: registerPlatformIntegrations,
});
