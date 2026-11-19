/**
 * Public authentication API for other modules. Import only from this file:
 *
 *   import { onDeviceRevoked } from '../authentication/api';
 *   onDeviceRevoked('lms.offline', async (e) => revokeOfflineLicencesOf(e.deviceId));
 */
export {
  onDeviceRevoked,
  onDeviceSignedOut,
  type DeviceRevokedEvent,
  type DeviceSignedOutEvent,
} from './device-events';
export { listUserDevices, revokeDevice, toDeviceDto } from './devices.service';
export { Device } from './models';
export { clearSignInLock, confirmAccountPassword, signInLocks } from './sign-in-lock';
