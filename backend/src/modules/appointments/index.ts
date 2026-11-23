import { defineModule } from '../../shared/module';
import { associateAppointmentModels, initAppointmentModels } from './appointments.models';
import { appointmentRoutes } from './appointments.routes';
import { registerAppointmentIntegrations } from './integrations';
import { REMINDER_JOB, runReminder } from './appointments.service';

export default defineModule({
  name: 'appointments',
  models: initAppointmentModels,
  associate: associateAppointmentModels,
  routes: appointmentRoutes,
  permissions: [
    {
      module: 'appointments',
      label: 'Parent-teacher appointments',
      area: 'Academics',
      describe: {
        view: ['View own meetings', 'See the parent-teacher meetings they take part in'],
        create: ['Request meetings', 'Parents request a meeting slot with a teacher'],
        edit: ['Set availability', 'Publish their own free slots for parent meetings'],
        approve: ['Handle meeting requests', 'Accept, decline or reschedule requests for their meetings'],
        export: ['Meeting reports', "Download reports of the branch's parent meetings"],
        configure: ['Manage all meetings', "Manage every teacher's slots and meetings"],
      },
      // view: own meetings · create: request (parents) · edit: own availability · approve: act on own
      // meetings (teachers) · export: branch reports · configure: manage every teacher's slots/meetings.
      actions: ['view', 'create', 'edit', 'approve', 'export', 'configure'],
      grants: {
        'branch-admin': ['view', 'edit', 'approve', 'export', 'configure'],
        teacher: ['view', 'edit', 'approve'],
        parent: ['view', 'create'],
      },
      selfService: ['create'],
    },
  ],
  jobs: {
    [REMINDER_JOB]: (payload) =>
      runReminder(payload as { appointmentId: number; startsAt: string; lead: number }),
  },
  onReady: registerAppointmentIntegrations,
});
