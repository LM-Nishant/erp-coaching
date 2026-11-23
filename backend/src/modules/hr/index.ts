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
      area: 'HR & payroll',
      describe: {
        view: ['View staff', 'See staff records, attendance and leave'],
        create: ['Add staff', 'Add employees and their documents'],
        edit: ['Edit staff', 'Change staff records, assets and attendance'],
        delete: ['Delete staff', 'Remove staff records'],
        approve: ['Approve staff leave', 'Decide leave requests and exits'],
        export: ['Export staff data', 'Download staff, attendance and leave reports'],
        configure: ['HR setup', 'Leave types, shifts and HR policies'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'],
      grants: { 'branch-admin': ['view', 'create', 'edit', 'approve', 'export'], accountant: ['view'] },
    },
    {
      // Employees acting on their own record (my profile, apply leave, my payslips).
      module: 'hr-self-service',
      label: 'Staff self-service',
      area: 'My account',
      describe: {
        view: ['Own HR record', 'See their own profile, attendance, leave and payslips'],
        create: ['Apply for leave', 'Apply for leave and mark their own attendance'],
      },
      actions: ['view', 'create'],
      grants: { teacher: 'all', 'branch-admin': 'all', accountant: 'all' },
    },
  ],
  onReady: registerHrIntegrations,
});
