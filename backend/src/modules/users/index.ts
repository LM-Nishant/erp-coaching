import { defineModule } from '../../shared/module';
import { User } from './user.model';
import { userRoutes } from './users.routes';

export default defineModule({
  name: 'users',
  models: (sequelize) => User.initModel(sequelize),
  routes: userRoutes,
  permissions: [
    {
      module: 'users',
      label: 'Users & staff accounts',
      actions: ['view', 'create', 'edit', 'delete', 'export'],
      grants: { 'branch-admin': ['view', 'create', 'edit'] },
    },
  ],
});
