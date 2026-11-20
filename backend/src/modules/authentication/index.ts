import { defineModule } from '../../shared/module';
import { associateAuthModels, initAuthModels } from './models';
import { authRoutes } from './auth.routes';
import {
  DEVICE_REVOKED_JOB,
  DEVICE_SIGNED_OUT_JOB,
  dispatchDeviceRevoked,
  dispatchDeviceSignedOut,
} from './device-events';
import { DEVICE_REVOKED_NOTICE_JOB, sendRevocationNotice } from './devices.service';
import { registerAuthenticationIntegrations } from './integrations';

export default defineModule({
  name: 'authentication',
  models: initAuthModels,
  associate: associateAuthModels,
  routes: authRoutes,
  jobs: {
    [DEVICE_REVOKED_JOB]: dispatchDeviceRevoked,
    [DEVICE_SIGNED_OUT_JOB]: dispatchDeviceSignedOut,
    [DEVICE_REVOKED_NOTICE_JOB]: sendRevocationNotice,
  },
  onReady: registerAuthenticationIntegrations,
});
