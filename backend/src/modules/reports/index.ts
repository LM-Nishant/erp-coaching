import { defineModule } from '../../shared/module';
import { EXPIRE_JOB, EXPORT_JOB, expireExportJob, runExportJob } from './exports.service';
import { registerReportIntegrations } from './integrations';
import { ReportExport } from './models';
import { reportsRoutes } from './reports.routes';

export default defineModule({
  name: 'reports',
  models: (sequelize) => ReportExport.initModel(sequelize),
  routes: reportsRoutes,
  permissions: [
    {
      module: 'reports',
      label: 'Reports & analytics',
      area: 'Reports & files',
      describe: {
        view: ['View reports', 'Open reports and dashboards for the areas they can see'],
        export: ['Export reports', 'Download reports as Excel, CSV or PDF'],
      },
      actions: ['view', 'export'],
      // Each report also needs the source module's permission; scope narrows rows per role.
      grants: {
        'branch-admin': 'all',
        accountant: 'all',
        teacher: ['view', 'export'],
        student: ['view'],
        parent: ['view'],
      },
    },
  ],
  jobs: {
    [EXPORT_JOB]: runExportJob,
    [EXPIRE_JOB]: expireExportJob,
  },
  onReady: registerReportIntegrations,
});
