import { defineModule } from '../../shared/module';
import { associateHrModels, initHrModels } from './models';
import { hrRoutes } from './hr.routes';
import { registerHrIntegrations } from './integrations';

export default defineModule({
  name: 'hr',
  models: initHrModels,
  associate: associateHrModels,
  routes: hrRoutes,
  permissions: [
    {
      module: 'hr',
      label: 'HR & staff',
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'],
      grants: { 'branch-admin': ['view', 'create', 'edit', 'approve', 'export'], accountant: ['view'] },
    },
    {
      // Employees acting on their own record (my profile, apply leave, my payslips).
      module: 'hr-self-service',
      label: 'Staff self-service',
      actions: ['view', 'create'],
      grants: { teacher: 'all', 'branch-admin': 'all', accountant: 'all' },
    },
  ],
  onReady: registerHrIntegrations,
});
