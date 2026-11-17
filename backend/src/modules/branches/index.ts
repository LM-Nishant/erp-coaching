import { defineModule } from '../../shared/module';
import { Branch } from './branch.model';
import { branchRoutes } from './branches.routes';

export default defineModule({
  name: 'branches',
  models: (sequelize) => Branch.initModel(sequelize),
  routes: branchRoutes,
  permissions: [
    {
      module: 'branches',
      label: 'Branches',
      actions: ['view', 'create', 'edit', 'delete'],
      grants: { 'branch-admin': ['view', 'edit'], accountant: ['view'], teacher: ['view'] },
    },
  ],
});
