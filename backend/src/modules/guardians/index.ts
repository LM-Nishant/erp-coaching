import { defineModule } from '../../shared/module';
import { registerGuardianIntegrations } from './integrations';
import { associateGuardianModels, initGuardianModels } from './models';
import { guardianRoutes } from './guardians.routes';

export default defineModule({
  name: 'guardians',
  models: initGuardianModels,
  associate: associateGuardianModels,
  routes: guardianRoutes,
  onReady: registerGuardianIntegrations,
  permissions: [
    {
      module: 'guardians',
      label: 'Guardians',
      actions: ['view', 'create', 'edit', 'delete'],
      grants: { 'branch-admin': 'all', teacher: ['view'], accountant: ['view'] },
    },
    {
      module: 'guardian-portal',
      label: 'Parent portal',
      actions: ['view'],
      grants: { parent: ['view'] },
      selfService: true,
    },
  ],
});
