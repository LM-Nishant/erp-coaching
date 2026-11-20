import { defineModule } from '../../shared/module';
import { associateGrievanceModels, initGrievanceModels } from './grievances.models';
import { grievanceRoutes } from './grievances.routes';
import { deliverGrievanceNotice } from './grievances.notifier';
import {
  SLA_CHECK_JOB,
  SLA_SWEEP_JOB,
  runSlaCheck,
  runSlaSweep,
  scheduleSlaSweep,
} from './grievances.service';

export default defineModule({
  name: 'grievances',
  models: initGrievanceModels,
  associate: associateGrievanceModels,
  routes: grievanceRoutes,
  permissions: [
    {
      module: 'grievances',
      label: 'Grievances & complaints',
      area: 'Communication',
      describe: {
        view: ['View grievances', 'See complaints raised by or about them'],
        create: ['Raise grievances', 'Raise a complaint or suggestion'],
        edit: ['Resolve grievances', 'Assign, reply to and close complaints'],
        export: ['Export grievances', 'Download grievance reports'],
        configure: ['Grievance setup', 'Categories, escalation and response times'],
      },
      actions: ['view', 'create', 'edit', 'export', 'configure'],
      grants: {
        'branch-admin': ['view', 'create', 'edit', 'export'],
        accountant: ['view', 'create'],
        teacher: ['view', 'create'],
        student: ['view', 'create'],
        parent: ['view', 'create'],
      },
    },
  ],
  jobs: {
    [SLA_CHECK_JOB]: (payload) => runSlaCheck(payload as { ticketId?: number }),
    [SLA_SWEEP_JOB]: () => runSlaSweep(),
    'grievances.notify': deliverGrievanceNotice,
  },
  onReady: scheduleSlaSweep,
});
