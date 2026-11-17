import { Op } from 'sequelize';
import type { NotificationEventDef, ParentPortalSectionDto } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { User } from '../users/user.model';
import { registerNotificationEvents } from '../notifications/api';
import { registerParentPortalProvider } from '../parent-portal/api';
import { Appointment } from './appointments.models';
import { localToday } from './appointments.service';

const ev = (
  key: string,
  label: string,
  variables: string[],
  title: string,
  body: string,
  defaultRecipientTypes: NotificationEventDef['defaultRecipientTypes'],
): NotificationEventDef => ({
  key,
  label,
  category: 'Appointments',
  variables,
  title,
  body,
  defaultChannels: ['in_app', 'push'],
  defaultRecipientTypes,
});

/** Events beyond the platform catalogue (requested/confirmed/cancelled/reminder already exist). */
export const APPOINTMENT_EVENTS: NotificationEventDef[] = [
  ev(
    'appointments.requested',
    'Appointment requested',
    ['requester', 'student', 'date', 'time', 'mode'],
    'Meeting request',
    '{{requester}} requested a {{mode}} meeting about {{student}} on {{date}} at {{time}}.',
    ['staff', 'user'],
  ),
  ev(
    'appointments.rejected',
    'Appointment declined',
    ['teacher', 'date', 'time', 'reason'],
    'Meeting request declined',
    '{{teacher}} could not accept the meeting on {{date}} at {{time}}: {{reason}}',
    ['user', 'guardian'],
  ),
  ev(
    'appointments.rescheduled',
    'Appointment rescheduled',
    ['teacher', 'requester', 'date', 'time', 'mode', 'previousDate', 'previousTime', 'reason'],
    'Meeting rescheduled',
    'The meeting with {{teacher}} moved from {{previousDate}} {{previousTime}} to {{date}} at {{time}} ({{mode}}).',
    ['user', 'guardian', 'staff'],
  ),
  ev(
    'appointments.summary-shared',
    'Meeting summary shared',
    ['teacher', 'date', 'summary'],
    'Meeting summary',
    '{{teacher}} shared notes from the meeting on {{date}}: {{summary}}',
    ['user', 'guardian'],
  ),
];

const label = (a: Appointment) =>
  `${a.teacher?.name ?? 'Teacher'} · ${a.mode === 'online' ? 'Online' : 'In person'}`;

/** Wires appointments into notifications and the parent portal (called from `onReady`). */
export function registerAppointmentIntegrations(): void {
  registerNotificationEvents(APPOINTMENT_EVENTS);
  registerParentPortalProvider({
    key: 'appointments',
    label: 'Parent-teacher meetings',
    order: 60,
    async summary(child): Promise<ParentPortalSectionDto | null> {
      const { instituteId } = requireTenantContext();
      const rows = await Appointment.findAll({
        where: {
          instituteId,
          studentId: child.studentId,
          status: { [Op.in]: ['requested', 'confirmed'] },
          date: { [Op.gte]: localToday() },
        },
        include: [{ model: User, as: 'teacher', attributes: ['id', 'name'] }],
        order: [
          ['date', 'ASC'],
          ['startTime', 'ASC'],
        ],
        limit: 5,
      });
      return {
        key: 'appointments',
        label: 'Parent-teacher meetings',
        metrics: [
          { label: 'Upcoming', value: rows.filter((r) => r.status === 'confirmed').length, tone: 'success' },
          {
            label: 'Awaiting teacher',
            value: rows.filter((r) => r.status === 'requested').length,
            tone: 'warning',
          },
        ],
        items: rows.map((r) => ({
          title: label(r),
          subtitle: r.status === 'requested' ? 'Awaiting confirmation' : 'Confirmed',
          date: `${r.date} ${r.startTime}`,
          link: `/appointments/${r.id}`,
        })),
      };
    },
    async monthlyReport(child, { from, to }) {
      const { instituteId } = requireTenantContext();
      const rows = await Appointment.findAll({
        where: { instituteId, studentId: child.studentId, date: { [Op.between]: [from, to] } },
        include: [{ model: User, as: 'teacher', attributes: ['id', 'name'] }],
        order: [
          ['date', 'ASC'],
          ['startTime', 'ASC'],
        ],
      });
      if (!rows.length) return null;
      const done = rows.filter((r) => r.status === 'completed');
      return {
        key: 'appointments',
        label: 'Parent-teacher meetings',
        metrics: [
          { label: 'Meetings held', value: done.length },
          {
            label: 'Cancelled / declined',
            value: rows.filter((r) => ['cancelled', 'rejected'].includes(r.status)).length,
          },
        ],
        // Only the shared summary is ever exposed to parents; private notes stay with the teacher.
        items: done.map((r) => ({ title: label(r), subtitle: r.sharedSummary ?? undefined, date: r.date })),
      };
    },
  });
}
