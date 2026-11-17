import type { NotificationEventDef } from '@erp/shared';
import {
  notify,
  batchMembersOf,
  guardiansOfStudentUsers,
  registerNotificationEvents,
} from '../notifications/api';

export const HOMEWORK_GRADED_EVENT = 'homework.graded';

/** `homework.assigned` / `homework.due` ship in the shared catalogue; LMS adds the grading notice. */
export function registerLmsNotificationEvents() {
  const graded: NotificationEventDef = {
    key: HOMEWORK_GRADED_EVENT,
    label: 'Homework graded',
    category: 'Homework',
    variables: ['title', 'marks', 'maxMarks', 'status'],
    defaultChannels: ['in_app', 'push'],
    defaultRecipientTypes: ['student', 'guardian'],
    title: 'Homework reviewed',
    body: '"{{title}}" was {{status}}. Marks: {{marks}}/{{maxMarks}}.',
  };
  registerNotificationEvents([graded]);
}

const fmtDue = (d: Date) =>
  d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

export async function notifyHomeworkAssigned(a: {
  batchId: number;
  branchId: number;
  title: string;
  subject: string | null;
  dueAt: Date;
  studentUserIds: number[];
}) {
  await notify({
    event: 'homework.assigned',
    branchId: a.branchId,
    recipients: [batchMembersOf(a.batchId), guardiansOfStudentUsers(a.studentUserIds)],
    data: { title: a.title, subject: a.subject ?? 'Homework', dueDate: fmtDue(a.dueAt) },
  });
}

export async function notifyHomeworkDue(a: {
  branchId: number;
  title: string;
  dueAt: Date;
  studentUserIds: number[];
}) {
  if (!a.studentUserIds.length) return;
  await notify({
    event: 'homework.due',
    branchId: a.branchId,
    recipients: [{ userIds: a.studentUserIds, type: 'student' }, guardiansOfStudentUsers(a.studentUserIds)],
    data: { title: a.title, dueDate: fmtDue(a.dueAt) },
  });
}

export async function notifyHomeworkGraded(a: {
  branchId: number;
  title: string;
  studentUserId: number;
  marks: number | null;
  maxMarks: number | null;
  status: 'graded' | 'returned';
}) {
  await notify({
    event: HOMEWORK_GRADED_EVENT,
    branchId: a.branchId,
    recipients: [{ userIds: [a.studentUserId], type: 'student' }, guardiansOfStudentUsers([a.studentUserId])],
    data: {
      title: a.title,
      marks: a.marks ?? '-',
      maxMarks: a.maxMarks ?? '-',
      status: a.status === 'returned' ? 'returned for resubmission' : 'graded',
    },
  });
}
