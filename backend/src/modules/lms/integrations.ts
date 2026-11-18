import { requireTenantContext } from '../../shared/context';
import { onDeviceRevoked } from '../authentication/api';
import { onLiveRecordingReady } from '../live-classes/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { importLiveRecording } from './live-recordings';
import { registerLmsParentPortal } from './parent-portal';
import { revokeDeviceOfflineLicenses } from './resources.service';

/** Registers LMS with provider modules; called from `onReady`. */
export function registerLmsIntegrations(): void {
  registerLmsParentPortal();

  // Live class recordings become published LMS videos on the class's course/batch.
  onLiveRecordingReady('lms.recording', async (e) => {
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'lms'))) return;
    await importLiveRecording(e);
  });

  // A revoked device loses its offline copies. Security clean-up, so not gated on the LMS plan.
  onDeviceRevoked('lms.offline', (e) =>
    revokeDeviceOfflineLicenses(e.userId, e.deviceId, new Date(e.revokedAt)),
  );
}
