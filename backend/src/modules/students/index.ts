import { defineModule } from '../../shared/module';
import { associateStudentModels, initStudentModels } from './models';
import { studentRoutes } from './students.routes';
import { studentPortalRoutes } from './student-portal.routes';
import { selfRegistrationRoutes } from './self-registration.routes';
import { registerStudentIntegrations } from './integrations';

export default defineModule({
  name: 'students',
  models: initStudentModels,
  associate: associateStudentModels,
  routes: (api) => {
    selfRegistrationRoutes(api);
    studentRoutes(api);
    studentPortalRoutes(api);
  },
  permissions: [
    {
      module: 'students',
      label: 'Students',
      actions: ['view', 'create', 'edit', 'delete', 'export', 'configure'],
      grants: {
        'branch-admin': ['view', 'create', 'edit', 'delete', 'export'],
        accountant: ['view'],
        teacher: ['view'],
      },
    },
    {
      module: 'student-portal',
      label: 'Student self-service',
      actions: ['view', 'edit'],
      grants: { student: ['view', 'edit'] },
    },
  ],
  onReady: registerStudentIntegrations,
});
