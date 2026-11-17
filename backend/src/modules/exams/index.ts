import { defineModule } from '../../shared/module';
import { associateExamModels, initExamModels } from './models';
import { examRoutes, PORTAL } from './exams.routes';
import { MODULE, REMINDER_JOB, runReminder } from './exams.service';
import { AUTO_SUBMIT_JOB, runAutoSubmit } from './attempts.service';
// Importing grading.service also registers the on-submit AI grading hook.
import { GRADE_JOB, runGradingJob } from './grading.service';
import { registerExamIntegrations } from './integrations';

export default defineModule({
  name: MODULE,
  models: initExamModels,
  associate: associateExamModels,
  routes: examRoutes,
  permissions: [
    {
      module: MODULE,
      label: 'Examinations & evaluation',
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export', 'configure'],
      grants: {
        'branch-admin': 'all',
        teacher: ['view', 'create', 'edit', 'delete', 'approve', 'export'],
      },
    },
    {
      module: PORTAL,
      label: 'Exams & results (students and parents)',
      actions: ['view', 'create'],
      grants: {
        student: ['view', 'create'],
        parent: ['view'],
      },
    },
  ],
  jobs: {
    [AUTO_SUBMIT_JOB]: (payload) => runAutoSubmit(payload as { attemptId: number }),
    [REMINDER_JOB]: (payload) => runReminder(payload as { examId: number; startAt: string }),
    [GRADE_JOB]: (payload) => runGradingJob(payload as { gradingJobId: number; answerIds: number[] }),
  },
  onReady: registerExamIntegrations,
});
