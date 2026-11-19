import { defineModule } from '../../shared/module';
import { registerJobFailureHandler } from '../../infrastructure/jobs/queue';
import { associateCalendarModels, initCalendarModels } from './calendar.models';
import { calendarRoutes } from './calendar.routes';
import { CALENDAR_SYNC_JOB, onCalendarSyncJobFailed, runCalendarSyncJob } from './sync.service';

/**
 * Calendar sync: Google Calendar (with Meet links) through the platform's OAuth client, or the
 * mock provider. Accounts are connected per institute (the organiser calendar) and per teacher.
 */
export default defineModule({
  name: 'calendar',
  models: initCalendarModels,
  associate: associateCalendarModels,
  routes: calendarRoutes,
  jobs: {
    [CALENDAR_SYNC_JOB]: (payload) => runCalendarSyncJob(payload),
  },
  onReady: () => {
    registerJobFailureHandler(CALENDAR_SYNC_JOB, onCalendarSyncJobFailed);
  },
});
