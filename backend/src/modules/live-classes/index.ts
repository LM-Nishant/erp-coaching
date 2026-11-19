import { defineModule } from '../../shared/module';
import { associateLiveModels, initLiveModels } from './models';
import { liveClassRoutes } from './live-classes.routes';
import {
  COLLECT_RECORDINGS_JOB,
  collectProviderRecordings,
  ENSURE_RECORDING_JOB,
  ensureRecordingJob,
  IMPORT_RECORDING_JOB,
  importProviderRecording,
} from './live-classes.service';
import { dispatchLiveEvent, LIVE_EVENT_JOB } from './live-events';
import { registerLiveClassIntegrations } from './integrations';
import { attachLiveSockets } from './realtime';

export default defineModule({
  name: 'live-classes',
  models: initLiveModels,
  associate: associateLiveModels,
  routes: liveClassRoutes,
  permissions: [
    {
      module: 'live-classes',
      label: 'Live classes',
      actions: ['view', 'create', 'edit', 'delete', 'configure'],
      grants: {
        'branch-admin': 'all',
        teacher: ['view', 'create', 'edit', 'delete'],
        student: ['view'],
      },
    },
  ],
  jobs: {
    [LIVE_EVENT_JOB]: dispatchLiveEvent,
    [IMPORT_RECORDING_JOB]: importProviderRecording,
    [COLLECT_RECORDINGS_JOB]: collectProviderRecordings,
    [ENSURE_RECORDING_JOB]: ensureRecordingJob,
  },
  onReady: registerLiveClassIntegrations,
  attachServer: (server) => {
    attachLiveSockets(server);
  },
});
