import { defineModule } from '../../shared/module';
import { associateFeeModels, initFeeModels } from './models';
import { feesRoutes } from './fees.routes';
import { registerFeesIntegrations } from './integrations';
import { registerFeeNotificationEvents } from './notifications';
import {
  FEES_INSTITUTE_SWEEP_JOB,
  FEES_SWEEP_JOB,
  runFeesSweep,
  runInstituteSweep,
  scheduleFeesSweep,
} from './jobs';

export default defineModule({
  name: 'fees',
  models: initFeeModels,
  associate: associateFeeModels,
  routes: feesRoutes,
  permissions: [
    {
      module: 'fees',
      label: 'Fees & payments',
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'],
      grants: {
        // Maker-checker: accountants collect and request; admins approve refunds, discounts and
        // (when enabled) offline receipts.
        'branch-admin': ['view', 'create', 'edit', 'delete', 'approve', 'export'],
        accountant: ['view', 'create', 'edit', 'export'],
      },
    },
    {
      module: 'accounting',
      label: 'Accounting (expenses, bank, P&L)',
      actions: ['view', 'create', 'edit', 'delete', 'export'],
      grants: { 'branch-admin': ['view', 'export'], accountant: 'all' },
    },
    {
      module: 'my-fees',
      label: 'My fees & online payment',
      actions: ['view', 'create'],
      grants: { student: ['view', 'create'], parent: ['view', 'create'] },
    },
  ],
  jobs: {
    [FEES_SWEEP_JOB]: () => runFeesSweep(),
    [FEES_INSTITUTE_SWEEP_JOB]: async () => {
      await runInstituteSweep();
    },
  },
  onReady: async () => {
    registerFeeNotificationEvents();
    registerFeesIntegrations();
    await scheduleFeesSweep();
  },
});
