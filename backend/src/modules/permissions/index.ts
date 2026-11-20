import { defineModule } from '../../shared/module';
import { associatePermissionModels, initPermissionModels } from './models';
import { roleRoutes } from './roles.routes';

export default defineModule({
  name: 'permissions',
  models: initPermissionModels,
  associate: associatePermissionModels,
  routes: roleRoutes,
  permissions: [
    {
      module: 'roles',
      label: 'Roles & permissions',
      area: 'Institute',
      adminOnly: ['create', 'edit', 'delete'],
      describe: {
        view: ['View roles', 'See roles and the permissions each one gives'],
        create: ['Create roles', 'Create custom roles and choose their permissions'],
        edit: ['Edit roles', 'Change the permissions of custom roles'],
        delete: ['Delete roles', 'Remove custom roles'],
      },
      actions: ['view', 'create', 'edit', 'delete'],
      grants: { 'branch-admin': ['view'] },
    },
  ],
});
