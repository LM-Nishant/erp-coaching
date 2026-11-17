import { defineModule } from '../../shared/module';
import { associatePermissionModels, initPermissionModels } from './models';
import { roleRoutes } from './roles.routes';

export default defineModule({
  name: 'permissions',
  models: initPermissionModels,
  associate: associatePermissionModels,
  routes: roleRoutes,
  permissions: [{ module: 'roles', label: 'Roles & permissions', actions: ['view', 'create', 'edit', 'delete'], grants: { 'branch-admin': ['view'] } }],
});
