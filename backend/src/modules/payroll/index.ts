import { defineModule } from '../../shared/module';
import { associatePayrollModels, initPayrollModels } from './models';
import { payrollRoutes } from './payroll.routes';
import { renderRunPayslips } from './payroll.service';
import { registerPayrollIntegrations } from './integrations';

export default defineModule({
  name: 'payroll',
  models: initPayrollModels,
  associate: associatePayrollModels,
  routes: payrollRoutes,
  onReady: registerPayrollIntegrations,
  permissions: [
    {
      module: 'payroll',
      label: 'Payroll',
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'],
      grants: { accountant: 'all', 'branch-admin': ['view'] },
    },
  ],
  jobs: {
    'payroll.render-payslips': async (payload) => {
      await renderRunPayslips(Number(payload.runId));
    },
  },
});
