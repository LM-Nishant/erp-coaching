import { defineModule } from '../../shared/module';
import { associateAttendanceModels, initAttendanceModels } from './models';
import { attendanceRoutes } from './attendance.routes';
import { ABSENT_ALERTS_JOB, sendAbsentAlerts } from './sessions.service';
import { registerAttendanceIntegrations } from './integrations';

export default defineModule({
  name: 'attendance',
  models: initAttendanceModels,
  associate: associateAttendanceModels,
  routes: attendanceRoutes,
  permissions: [
    {
      module: 'attendance',
      label: 'Student attendance',
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'],
      grants: { 'branch-admin': 'all', teacher: ['view', 'create'], accountant: ['view', 'export'] },
    },
    {
      // Students checking in and viewing their own attendance; parents for linked children.
      module: 'attendance-self',
      label: 'My attendance',
      actions: ['view', 'create'],
      grants: { student: 'all', parent: 'all' },
      selfService: true,
    },
  ],
  jobs: { [ABSENT_ALERTS_JOB]: sendAbsentAlerts },
  onReady: registerAttendanceIntegrations,
});
