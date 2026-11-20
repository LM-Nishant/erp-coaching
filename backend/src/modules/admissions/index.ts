import { defineModule } from '../../shared/module';
import { associateAdmissionModels, initAdmissionModels } from './models';
import { admissionRoutes } from './admissions.routes';
import { FOLLOW_UP_REMINDER_JOB, followUpReminderJob } from './admissions.service';
import { ADMISSION_COMPLETED_JOB, handleAdmissionCompleted } from './admission-events';

export default defineModule({
  name: 'admissions',
  models: initAdmissionModels,
  associate: associateAdmissionModels,
  routes: admissionRoutes,
  jobs: {
    [FOLLOW_UP_REMINDER_JOB]: followUpReminderJob,
    [ADMISSION_COMPLETED_JOB]: handleAdmissionCompleted,
  },
  permissions: [
    {
      module: 'admissions',
      label: 'Admissions & enquiries',
      area: 'People & admissions',
      describe: {
        view: ['View enquiries', 'See enquiries, leads and admission applications'],
        create: ['Add enquiries', 'Record walk-in and phone enquiries and new applications'],
        edit: ['Follow up enquiries', 'Update leads, add follow-ups and edit applications'],
        delete: ['Delete enquiries', 'Remove enquiries and applications'],
        approve: ['Admit students', 'Approve, waitlist, reject applications and admit into a batch'],
        configure: ['Admission forms', 'Design online admission forms and enquiry sources'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'configure'],
      grants: { 'branch-admin': ['view', 'create', 'edit', 'delete', 'approve'], accountant: ['view'] },
    },
  ],
});
