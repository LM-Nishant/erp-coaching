import { defineModule } from '../../shared/module';
import { registerGuardianIntegrations } from './integrations';
import { associateGuardianModels, initGuardianModels } from './models';
import { guardianRoutes } from './guardians.routes';

export default defineModule({
  name: 'guardians',
  models: initGuardianModels,
  associate: associateGuardianModels,
  routes: guardianRoutes,
  onReady: registerGuardianIntegrations,
  permissions: [
    {
      module: 'guardians',
      label: 'Guardians',
      area: 'People & admissions',
      describe: {
        view: ['View guardians', "See parents and guardians and the students they're linked to"],
        create: ['Add guardians', 'Add parents and guardians and link them to students'],
        edit: ['Edit guardians', 'Change guardian details and links'],
        delete: ['Remove guardians', 'Unlink or remove guardians'],
      },
      actions: ['view', 'create', 'edit', 'delete'],
      grants: { 'branch-admin': 'all', teacher: ['view'], accountant: ['view'] },
    },
    {
      module: 'guardian-portal',
      label: 'Parent portal',
      area: 'My account',
      describe: {
        view: ['Linked children', 'Parents see the children linked to them'],
      },
      actions: ['view'],
      grants: { parent: ['view'] },
      selfService: true,
    },
  ],
});
