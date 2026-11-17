import { requireTenantContext } from '../../shared/context';
import { getInstituteTimezone } from '../../shared/timezone';
import { ClassSession, onClassSessionCompleted } from '../academics/api';
import { onLiveSessionEnded, type LiveSessionEndedEvent } from '../live-classes/api';
import { registerNotificationEvents } from '../notifications/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { AttendanceSession } from './models';
import {
  closeSession,
  recordAttendance,
  resolveSession,
  rosterStudentIds,
  type SessionRef,
} from './sessions.service';
import { getAttendanceSettings } from './settings';
import { localDate, localHhmm } from './time';
import { ATTENDANCE_EVENTS } from './requests.service';
import { registerAttendanceParentPortal } from './parent-portal';

/** Registers attendance with provider modules; called from `onReady`. */
export function registerAttendanceIntegrations(): void {
  registerNotificationEvents(ATTENDANCE_EVENTS);
  registerAttendanceParentPortal();

  // A completed class closes its open attendance: unmarked students become absent and parents are alerted.
  onClassSessionCompleted('attendance.close-session', async (e) => {
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'attendance'))) return;
    const session = await AttendanceSession.findOne({
      where: { instituteId, sessionKey: `class:${e.classSessionId}`, status: 'open' },
    });
    if (session) await closeSession(session);
  });

  // Live classroom joins become attendance (source `live`); see `recordLiveAttendance`.
  onLiveSessionEnded('attendance.live', async (e) => {
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'attendance'))) return;
    await recordLiveAttendance(e);
  });
}

/**
 * Marks live-class attendance. A class-linked live session shares the class's attendance session
 * (`class:<classSessionId>`) so classroom and live marks merge; otherwise it gets `live:<id>`.
 * Manual/earlier marks are never overwritten, except auto-absent `system` marks
 * left by a class that was completed before this ran. Idempotent.
 */
export async function recordLiveAttendance(e: LiveSessionEndedEvent): Promise<void> {
  const { instituteId } = requireTenantContext();
  const settings = await getAttendanceSettings();
  const linked = e.classSessionId
    ? await ClassSession.findOne({
        where: { instituteId, id: e.classSessionId },
        attributes: ['id', 'status'],
      })
    : null;
  const scheduledStart = new Date(e.scheduledStartAt);
  const tz = await getInstituteTimezone(instituteId);
  const ref: SessionRef =
    linked && linked.status !== 'cancelled'
      ? { classSessionId: linked.id }
      : {
          live: {
            liveSessionId: e.liveSessionId,
            branchId: e.branchId,
            batchId: e.batchId,
            date: localDate(tz, scheduledStart),
            startTime: localHhmm(scheduledStart, tz),
            endTime: localHhmm(new Date(e.scheduledEndAt), tz),
            teacherUserId: e.teacherUserId,
          },
        };
  const session = await resolveSession(ref, { settings });
  const roster = new Set(await rosterStudentIds(session.batchId, session.date));

  const startedMs = Date.parse(e.startedAt);
  const classSeconds = Math.max(0, (Date.parse(e.endedAt) - startedMs) / 1000);
  const marks = new Map<number, { status: 'present' | 'late' | 'absent'; remarks: string | null }>();
  for (const p of e.participants) {
    if (p.role !== 'student') continue;
    const minutes = Math.round(p.totalSeconds / 60);
    if (classSeconds > 0 && p.totalSeconds * 100 < settings.liveMinPercent * classSeconds) {
      marks.set(p.userId, { status: 'absent', remarks: `Live class: attended ${minutes} min` });
      continue;
    }
    const joinedMs = p.firstJoinedAt ? Date.parse(p.firstJoinedAt) : startedMs;
    const late = joinedMs - startedMs > settings.lateAfterMinutes * 60000;
    marks.set(p.userId, { status: late ? 'late' : 'present', remarks: null });
  }
  for (const id of e.absentStudentUserIds)
    if (!marks.has(id)) marks.set(id, { status: 'absent', remarks: 'Did not join the live class' });

  for (const [studentUserId, m] of marks) {
    if (!roster.has(studentUserId)) continue; // left the batch since the class
    await recordAttendance({
      ...ref,
      studentUserId,
      status: m.status,
      source: 'live',
      remarks: m.remarks,
      markedAt: new Date(e.endedAt),
      replaceSystemMark: m.status !== 'absent',
    });
  }
  // `live:<id>` registers end with the class. A class completed earlier (its close may have run
  // before this register existed) is closed here; otherwise the class-completed listener closes it.
  if (session.kind === 'live' || (session.kind === 'class' && linked?.status === 'completed'))
    await closeSession(session);
}
