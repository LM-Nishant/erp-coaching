import type { NotificationEventDef } from '@erp/shared';
import { notify, registerNotificationEvents } from '../notifications/api';

export const DOUBT_ASKED_EVENT = 'doubts.asked';
export const DOUBT_ANSWERED_EVENT = 'doubts.answered';

export function registerDoubtNotificationEvents() {
  const events: NotificationEventDef[] = [
    {
      key: DOUBT_ASKED_EVENT,
      label: 'New doubt from a student',
      category: 'Doubts',
      variables: ['student', 'subject', 'question'],
      defaultChannels: ['in_app', 'push'],
      defaultRecipientTypes: ['user'],
      title: 'New doubt from {{student}}',
      body: '{{subject}}: {{question}}',
    },
    {
      key: DOUBT_ANSWERED_EVENT,
      label: 'Doubt answered',
      category: 'Doubts',
      variables: ['teacher', 'subject', 'question'],
      defaultChannels: ['in_app', 'push'],
      defaultRecipientTypes: ['student'],
      title: '{{teacher}} answered your doubt',
      body: '{{subject}}: {{question}}',
    },
  ];
  registerNotificationEvents(events);
}

const preview = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);

export async function notifyDoubtAsked(d: {
  doubtId: number;
  branchId: number | null;
  teacherUserIds: number[];
  student: string;
  subject: string | null;
  question: string;
}) {
  if (!d.teacherUserIds.length) return;
  await notify({
    event: DOUBT_ASKED_EVENT,
    branchId: d.branchId,
    recipients: [{ userIds: d.teacherUserIds, type: 'user' }],
    data: {
      doubtId: d.doubtId,
      student: d.student,
      subject: d.subject ?? 'Doubt',
      question: preview(d.question),
    },
  });
}

export async function notifyDoubtAnswered(d: {
  doubtId: number;
  branchId: number | null;
  studentUserId: number;
  teacher: string;
  subject: string | null;
  question: string;
}) {
  await notify({
    event: DOUBT_ANSWERED_EVENT,
    branchId: d.branchId,
    recipients: [{ userIds: [d.studentUserId], type: 'student' }],
    data: {
      doubtId: d.doubtId,
      teacher: d.teacher,
      subject: d.subject ?? 'Doubt',
      question: preview(d.question),
    },
  });
}
