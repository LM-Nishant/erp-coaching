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
      area: 'People & admissions',
      describe: {
        view: ['View members', 'See who can sign in, their roles and devices'],
        create: ['Add members', 'Give a person sign-in access with roles'],
        edit: ['Change member access', 'Change roles and branches, sign devices out'],
        delete: ['Remove members', "Take away a person's access to the institute"],
        export: ['Export members', 'Download the list of members'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'export'],
      grants: { 'branch-admin': ['view', 'create', 'edit'] },
    },
  ],
});
