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
      area: 'People & admissions',
      describe: {
        view: ['View students', 'See student profiles and records'],
        create: ['Add students', 'Add new students'],
        edit: ['Edit students', 'Change student details and documents'],
        delete: ['Delete students', 'Remove students'],
        export: ['Export students', 'Download student lists and records'],
        configure: ['Student setup', 'Student ID format, custom fields and student settings'],
      },
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
      area: 'My account',
      describe: {
        view: ['Own student profile', 'Students see their own profile'],
        edit: ['Edit own profile', 'Students update their own contact details'],
      },
      actions: ['view', 'edit'],
      grants: { student: ['view', 'edit'] },
      selfService: true,
    },
  ],
  onReady: registerStudentIntegrations,
});
