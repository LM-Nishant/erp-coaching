import { defineModule } from '../../shared/module';
import { associatePayrollModels, initPayrollModels } from './models';
import { payrollRoutes } from './payroll.routes';
import { renderRunPayslips } from './payroll.service';

export default defineModule({
  name: 'payroll',
  models: initPayrollModels,
  associate: associatePayrollModels,
  routes: payrollRoutes,
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
