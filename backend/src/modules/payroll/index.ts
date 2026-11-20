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
      area: 'HR & payroll',
      describe: {
        view: ['View payroll', 'See salary structures, payroll runs and payslips'],
        create: ['Run payroll', 'Start payroll runs and add salary structures'],
        edit: ['Edit payroll', 'Change salaries, deductions and payroll runs'],
        delete: ['Delete payroll entries', 'Remove draft payroll runs and salary structures'],
        approve: ['Approve payroll', 'Approve and finalise payroll runs and settlements'],
        export: ['Payroll reports', 'Download the salary register and statutory reports'],
        configure: ['Payroll setup', 'Salary components and payroll settings'],
      },
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
