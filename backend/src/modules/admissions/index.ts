import { defineModule } from '../../shared/module';
import { associateAdmissionModels, initAdmissionModels } from './models';
import { admissionRoutes } from './admissions.routes';
import { FOLLOW_UP_REMINDER_JOB, followUpReminderJob } from './admissions.service';

export default defineModule({
  name: 'admissions',
  models: initAdmissionModels,
  associate: associateAdmissionModels,
  routes: admissionRoutes,
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
