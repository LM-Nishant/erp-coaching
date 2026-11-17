import { defineModule } from '../../shared/module';
import { Institute } from './institute.model';
import { InstituteSetting } from './institute-setting.model';
import { instituteRoutes } from './institutes.routes';
import { instituteAdminRoutes } from './institutes.admin.routes';

export default defineModule({
  name: 'institutes',
  models: (sequelize) => {
    Institute.initModel(sequelize);
    InstituteSetting.initModel(sequelize);
  },
  routes: (api) => {
    instituteRoutes(api);
    instituteAdminRoutes(api);
  },
  permissions: [
    {
      module: 'institute',
      label: 'Institute profile & settings',
      actions: ['view', 'configure'],
      grants: {
        'branch-admin': ['view'],
        accountant: ['view'],
        teacher: ['view'],
        student: ['view'],
        parent: ['view'],
      },
    },
  ],
});
