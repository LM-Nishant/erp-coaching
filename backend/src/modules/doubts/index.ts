import { defineModule } from '../../shared/module';
import { associateDoubtModels, initDoubtModels } from './doubts.models';
import { registerDoubtNotificationEvents } from './doubts.notifications';
import { doubtRoutes } from './doubts.routes';
import { MODULE } from './doubts.service';

// Catalogue entries must exist before any request calls notify().
registerDoubtNotificationEvents();

export default defineModule({
  name: MODULE,
  models: initDoubtModels,
  associate: associateDoubtModels,
  routes: doubtRoutes,
  permissions: [
    {
      module: MODULE,
      label: 'Doubts',
      area: 'Learning & exams',
      describe: {
        view: ['See doubts', 'Open doubts they asked or can answer'],
        create: ['Ask doubts', 'Ask a teacher a question, with a photo if needed'],
        edit: ['Answer doubts', 'Reply to and close doubts from their batches'],
        export: ['See all doubts', 'See and answer every doubt in their branches'],
      },
      actions: ['view', 'create', 'edit', 'export'],
      selfService: ['create'],
      grants: {
        'branch-admin': ['view', 'edit', 'export'],
        teacher: ['view', 'edit'],
        student: ['view', 'create'],
      },
    },
  ],
});
