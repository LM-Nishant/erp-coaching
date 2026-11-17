import { requireTenantContext } from '../../shared/context';
import { onClassSessionCompleted } from '../academics/api';
import { registerNotificationEvents } from '../notifications/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { AttendanceSession } from './models';
import { closeSession } from './sessions.service';
import { ATTENDANCE_EVENTS } from './requests.service';

/** Registers attendance with provider modules; called from `onReady`. */
export function registerAttendanceIntegrations(): void {
  registerNotificationEvents(ATTENDANCE_EVENTS);

  // A completed class closes its open attendance: unmarked students become absent and parents are alerted.
  onClassSessionCompleted('attendance.close-session', async (e) => {
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'attendance'))) return;
    const session = await AttendanceSession.findOne({
      where: { instituteId, sessionKey: `class:${e.classSessionId}`, status: 'open' },
    });
    if (session) await closeSession(session);
  });
}
