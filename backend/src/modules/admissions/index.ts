import { defineModule } from '../../shared/module';
import { associateAdmissionModels, initAdmissionModels } from './models';
import { admissionRoutes } from './admissions.routes';
import { selfRegistrationRoutes } from '../students/self-registration.routes';
import { FOLLOW_UP_REMINDER_JOB, followUpReminderJob } from './admissions.service';

export default defineModule({
  name: 'admissions',
  models: initAdmissionModels,
  associate: associateAdmissionModels,
  // Public self-registration is registered here because modules mount in alphabetical order and
  // the permissions module mounts an authenticated router at `/api/`, which would otherwise
  // intercept unauthenticated requests to routes registered after it (e.g. by `students`).
  routes: (api) => {
    selfRegistrationRoutes(api);
    admissionRoutes(api);
  },
  jobs: { [FOLLOW_UP_REMINDER_JOB]: followUpReminderJob },
  permissions: [
    {
      module: 'admissions',
      label: 'Admissions & enquiries',
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'configure'],
      grants: { 'branch-admin': ['view', 'create', 'edit', 'delete', 'approve'], accountant: ['view'] },
    },
  ],
});
