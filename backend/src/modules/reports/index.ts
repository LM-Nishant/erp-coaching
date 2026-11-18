import { defineModule } from '../../shared/module';
import { ReportExport } from './models';

export default defineModule({
  name: 'reports',
  models: (sequelize) => ReportExport.initModel(sequelize),
  permissions: [
    {
      module: 'reports',
      label: 'Reports & analytics',
      actions: ['view', 'export'],
      grants: {
        'branch-admin': 'all',
        accountant: 'all',
        teacher: ['view', 'export'],
        student: ['view'],
        parent: ['view'],
      },
    },
  ],
});
