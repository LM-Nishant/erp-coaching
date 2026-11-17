import { PARENT_MONTHLY_REPORT_JOB } from '@erp/shared';
import { defineModule } from '../../shared/module';
import { associateParentPortalModels, initParentPortalModels } from './parent-portal.models';
import { parentPortalRoutes } from './parent-portal.routes';
import { registerParentPortalIntegrations } from './integrations';
import {
  MONTHLY_SWEEP_JOB,
  runMonthlyReport,
  runMonthlySweep,
  scheduleMonthlySweep,
} from './parent-portal.service';

export default defineModule({
  name: 'parent-portal',
  models: (sequelize) => {
    initParentPortalModels(sequelize);
    // Registered at load time so the catalogue/templates UI lists it before onReady.
    registerParentPortalIntegrations();
  },
  associate: associateParentPortalModels,
  routes: parentPortalRoutes,
  permissions: [
    {
      module: 'parent-portal',
      label: 'Parent portal',
      actions: ['view', 'configure'],
      grants: {
        'branch-admin': ['configure'],
        parent: ['view'],
      },
    },
  ],
  jobs: {
    [PARENT_MONTHLY_REPORT_JOB]: async (payload) => {
      await runMonthlyReport(payload as { period?: string; studentIds?: number[] | null });
    },
    [MONTHLY_SWEEP_JOB]: () => runMonthlySweep(),
  },
  onReady: scheduleMonthlySweep,
});
