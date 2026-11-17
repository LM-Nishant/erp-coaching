import { ACADEMICS_CLASS_CHANGED_JOB, type ClassChangedJobPayload } from '@erp/shared';
import { defineModule } from '../../shared/module';
import { associateAcademicsModels, initAcademicsModels } from './models';
import { academicsRoutes } from './academics.routes';
import { handleClassChanged } from './academics.service';

export default defineModule({
  name: 'academics',
  models: initAcademicsModels,
  associate: associateAcademicsModels,
  routes: academicsRoutes,
  permissions: [
    {
      module: 'academics',
      label: 'Academics',
      actions: ['view', 'create', 'edit', 'delete', 'configure'],
      grants: {
        'branch-admin': 'all',
        teacher: ['view'],
        student: ['view'],
        parent: ['view'],
        accountant: ['view'],
      },
    },
    {
      module: 'class-notes',
      label: 'Class notes & homework',
      actions: ['view', 'create', 'edit', 'delete'],
      grants: { 'branch-admin': 'all', teacher: 'all', student: ['view'], parent: ['view'] },
    },
  ],
  jobs: {
    [ACADEMICS_CLASS_CHANGED_JOB]: (payload) =>
      handleClassChanged(payload as unknown as ClassChangedJobPayload),
  },
});
