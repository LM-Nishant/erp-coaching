import { defineModule } from '../../shared/module';
import { associateQuestionBankModels, initQuestionBankModels } from './models';
import { questionBankRoutes } from './question-bank.routes';
import { registerJobFailureHandler } from '../../infrastructure/jobs/queue';
import { PDF_IMPORT_JOB, failPdfImportJob, runPdfImportJob } from './pdf-import.service';

export default defineModule({
  name: 'question-bank',
  models: initQuestionBankModels,
  associate: associateQuestionBankModels,
  routes: questionBankRoutes,
  jobs: {
    [PDF_IMPORT_JOB]: (payload) => runPdfImportJob(payload as { importId: number }),
  },
  onReady: () => {
    registerJobFailureHandler(PDF_IMPORT_JOB, failPdfImportJob);
  },
  permissions: [
    {
      module: 'question-bank',
      label: 'Question bank',
      area: 'Learning & exams',
      describe: {
        view: ['View questions', 'Browse the question bank'],
        create: ['Add questions', 'Write and import questions'],
        edit: ['Edit questions', 'Change questions and their answers'],
        delete: ['Delete questions', 'Remove questions'],
        export: ['Export questions', 'Download question papers and the question bank'],
        configure: ['Question bank setup', 'Topics, tags and difficulty levels'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'export', 'configure'],
      grants: {
        'branch-admin': 'all',
        teacher: ['view', 'create', 'edit', 'delete', 'export'],
      },
    },
  ],
});
