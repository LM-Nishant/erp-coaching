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
      area: 'Institute',
      adminOnly: ['create', 'delete', 'configure'],
      describe: {
        view: ['View branches', 'See branches and their details'],
        create: ['Add branches', 'Open a new branch'],
        edit: ['Edit branches', 'Change branch details, address and contacts'],
        delete: ['Delete branches', 'Remove a branch'],
        configure: ['Close branches', 'Close and re-activate branches'],
      },
      // `configure`: close and re-activate branches (institute admins; not branch admins).
      actions: ['view', 'create', 'edit', 'delete', 'configure'],
      grants: { 'branch-admin': ['view', 'edit'], accountant: ['view'], teacher: ['view'] },
    },
  ],
});
