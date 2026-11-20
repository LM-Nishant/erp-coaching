import { defineModule } from '../../shared/module';
import { associateLmsModels, initLmsModels } from './models';
import { LMS, LMS_ASSIGNMENTS, lmsRoutes } from './lms.routes';
import { DUE_REMINDER_JOB, runDueReminder } from './assignments.service';
import { TRANSCODE_JOB, runTranscode } from './transcode.job';
import { registerLmsNotificationEvents } from './notifications';
import { registerLmsIntegrations } from './integrations';

// Catalogue entries must exist before any request or job calls notify().
registerLmsNotificationEvents();

export default defineModule({
  name: LMS,
  models: initLmsModels,
  associate: associateLmsModels,
  routes: lmsRoutes,
  permissions: [
    {
      module: LMS,
      label: 'Learning content',
      area: 'Learning & exams',
      describe: {
        view: ['View learning content', 'Watch lectures and read study material'],
        create: ['Add learning content', 'Upload lectures, notes and study material'],
        edit: ['Edit learning content', 'Change lectures and study material'],
        delete: ['Delete learning content', 'Remove lectures and study material'],
        publish: ['Publish content', 'Make content visible to students'],
        configure: ['Content setup', 'Content protection, downloads and paid-course settings'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'publish', 'configure'],
      grants: {
        'branch-admin': 'all',
        teacher: ['view', 'create', 'edit', 'delete', 'publish'],
        student: ['view'],
        parent: ['view'],
      },
    },
    {
      // `create` = submit homework (learners); `edit` = author and grade (staff).
      module: LMS_ASSIGNMENTS,
      label: 'Homework & assignments',
      area: 'Learning & exams',
      describe: {
        view: ['View assignments', 'See homework and assignments'],
        create: ['Submit assignments', 'Hand in homework and assignments'],
        edit: ['Set and grade assignments', 'Create, edit and grade homework and assignments'],
        delete: ['Delete assignments', 'Remove homework and assignments'],
        publish: ['Publish assignments', 'Release assignments and grades to students'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'publish'],
      grants: {
        'branch-admin': 'all',
        teacher: 'all',
        student: ['view', 'create'],
        parent: ['view'],
      },
    },
  ],
  jobs: {
    [TRANSCODE_JOB]: (payload) => runTranscode(payload as { resourceId: number }),
    [DUE_REMINDER_JOB]: (payload) => runDueReminder(payload as { assignmentId: number; dueAt: string }),
  },
  onReady: registerLmsIntegrations,
});
