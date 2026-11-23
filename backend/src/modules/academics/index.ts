import { ACADEMICS_CLASS_CHANGED_JOB, type ClassChangedJobPayload } from '@erp/shared';
import { defineModule } from '../../shared/module';
import { registerAcademicsIntegrations } from './integrations';
import { associateAcademicsModels, initAcademicsModels } from './models';
import { academicsRoutes } from './academics.routes';
import { handleClassChanged } from './academics.service';
import { CLASS_COMPLETED_JOB, handleClassCompleted } from './class-events';

export default defineModule({
  name: 'academics',
  models: initAcademicsModels,
  associate: associateAcademicsModels,
  routes: academicsRoutes,
  onReady: registerAcademicsIntegrations,
  permissions: [
    {
      module: 'academics',
      label: 'Academics',
      area: 'Academics',
      describe: {
        view: ['View academics', 'Courses, batches, subjects, timetables and the academic calendar'],
        create: ['Add academics', 'Create courses, batches, subjects and timetable slots'],
        edit: ['Edit academics', 'Change courses, batches, timetables and enrol students in batches'],
        delete: ['Delete academics', 'Remove courses, batches, subjects and timetable slots'],
        configure: ['Academic setup', 'Academic sessions, promotion to the next session and holidays'],
      },
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
      area: 'Academics',
      describe: {
        view: ['View class notes', 'Read class notes and homework posted for batches'],
        create: ['Post class notes', 'Share class notes and homework with a batch'],
        edit: ['Edit class notes', 'Change posted class notes and homework'],
        delete: ['Delete class notes', 'Remove class notes and homework'],
      },
      actions: ['view', 'create', 'edit', 'delete'],
      grants: { 'branch-admin': 'all', teacher: 'all', student: ['view'], parent: ['view'] },
    },
  ],
  jobs: {
    [ACADEMICS_CLASS_CHANGED_JOB]: (payload) =>
      handleClassChanged(payload as unknown as ClassChangedJobPayload),
    [CLASS_COMPLETED_JOB]: handleClassCompleted,
  },
});
