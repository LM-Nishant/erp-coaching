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
