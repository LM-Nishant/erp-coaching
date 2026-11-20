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
      area: 'Learning & exams',
      describe: {
        view: ['View exams', 'See exams, papers and results'],
        create: ['Create exams', 'Schedule exams and set papers'],
        edit: ['Edit exams', 'Change exams, papers and enter marks'],
        delete: ['Delete exams', 'Remove exams and papers'],
        approve: ['Evaluate answers', 'Grade answer sheets and approve scores'],
        publish: ['Publish results', 'Release results to students and parents'],
        export: ['Export results', 'Download marks sheets and result reports'],
        configure: ['Exam setup', 'Grading schemes, report-card templates and exam settings'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export', 'configure'],
      grants: {
        'branch-admin': 'all',
        teacher: ['view', 'create', 'edit', 'delete', 'approve', 'export'],
      },
    },
    {
      module: PORTAL,
      label: 'Exams & results (students and parents)',
      area: 'My account',
      describe: {
        view: ['Own results', "See their own (or their children's) exams and results"],
        create: ['Take exams', 'Attempt online exams'],
      },
      actions: ['view', 'create'],
      grants: {
        student: ['view', 'create'],
        parent: ['view'],
      },
      selfService: true,
    },
  ],
  jobs: {
    [AUTO_SUBMIT_JOB]: (payload) => runAutoSubmit(payload as { attemptId: number }),
    [REMINDER_JOB]: (payload) => runReminder(payload as { examId: number; startAt: string }),
    [GRADE_JOB]: (payload) => runGradingJob(payload as { gradingJobId: number; answerIds: number[] }),
  },
  onReady: registerExamIntegrations,
});
