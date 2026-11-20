import { Op } from 'sequelize';
import type { AppointmentStatus } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { getInstituteTimezone } from '../../shared/timezone';
import { User } from '../users/user.model';
import { Student } from '../students/api';
import type { CalendarSource } from '../calendar/api';
import { Appointment } from './appointments.models';
import { localToday } from './appointments.service';

/** Meetings that belong in the calendar; held meetings stay there as history. */
const ON_CALENDAR: AppointmentStatus[] = ['confirmed', 'completed', 'no_show'];

const person = { model: User, attributes: ['id', 'name', 'email'] };

/**
 * Confirmed parent-teacher meetings as calendar events: in the teacher's own Google Calendar when
 * connected, else the institute's organiser calendar. The teacher and the requesting parent are
 * invited (when they have an email address) and online meetings get a Google Meet link, unless the
 * teacher entered their own link.
 */
export const appointmentCalendarSource: CalendarSource = {
  async load(id) {
    const { instituteId } = requireTenantContext();
    const a = await Appointment.findOne({
      where: { instituteId, id },
      include: [
        { ...person, as: 'teacher' },
        { ...person, as: 'requestedBy' },
        { model: Student, as: 'student', attributes: ['id', 'name'] },
      ],
    });
    if (!a || !ON_CALENDAR.includes(a.status)) return null;
    const people = [a.teacher, a.requestedBy].filter((u): u is User => Boolean(u));
    return {
      ownerUserId: a.teacherUserId,
      event: {
        title: `Parent-teacher meeting: ${a.student?.name ?? 'student'}`,
        description: a.agenda ?? undefined,
        start: `${a.date}T${a.startTime}`,
        end: `${a.date}T${a.endTime}`,
        timeZone: await getInstituteTimezone(instituteId),
        attendees: people.map((u) => ({ name: u.name, email: u.email })),
        withMeeting: a.mode === 'online',
        location: a.mode === 'offline' ? a.location : null,
      },
      customMeetingUrl: a.mode === 'online' && a.meetingUrlCustom ? a.meetingUrl : null,
    };
  },

  async saved(id, { provider, eventId, meetingUrl }) {
    const { instituteId } = requireTenantContext();
    await Appointment.update(
      { calendarProvider: provider, calendarEventId: eventId },
      { where: { instituteId, id } },
    );
    // A link the teacher entered is kept; a Meet link follows the event.
    await Appointment.update({ meetingUrl }, { where: { instituteId, id, meetingUrlCustom: false } });
  },

  async upcoming(ownerUserId) {
    const { instituteId } = requireTenantContext();
    const rows = await Appointment.findAll({
      where: {
        instituteId,
        status: 'confirmed',
        date: { [Op.gte]: await localToday(instituteId) },
        ...(ownerUserId ? { teacherUserId: ownerUserId } : {}),
      },
      attributes: ['id'],
      order: [
        ['date', 'ASC'],
        ['startTime', 'ASC'],
      ],
      limit: 500,
    });
    return rows.map((r) => r.id);
  },
};
