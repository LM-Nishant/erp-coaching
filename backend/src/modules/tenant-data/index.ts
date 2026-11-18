import { defineModule } from '../../shared/module';
import {
  PURGE_JOB,
  registerTenantDataNotificationEvents,
  runPurgeJob,
  scheduleTenantDataSweep,
  TENANT_DATA_SWEEP_JOB,
  tenantDataSweepJob,
} from './deletion.service';
import { EXPORT_JOB, runExportJob } from './export.service';
import { initTenantDataModels } from './models';
import { tenantDataRoutes } from './tenant-data.routes';

/** Institute data portability (full export) and the audited institute deletion workflow. */
export default defineModule({
  name: 'tenant-data',
  models: initTenantDataModels,
  routes: tenantDataRoutes,
  permissions: [
    {
      module: 'tenant-data',
      label: 'Data export & deletion',
      actions: ['view', 'export', 'delete'],
    },
  ],
  jobs: {
    [EXPORT_JOB]: runExportJob,
    [PURGE_JOB]: runPurgeJob,
    [TENANT_DATA_SWEEP_JOB]: tenantDataSweepJob,
  },
  onReady: async () => {
    registerTenantDataNotificationEvents();
    await scheduleTenantDataSweep();
  },
});
