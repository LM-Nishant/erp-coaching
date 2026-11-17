/** Notifications & communication (spec §4.14): shared constants and DTOs. */

export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'sms', 'whatsapp', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
/** Channels delivered through an external provider (everything except the in-app inbox). */
export type ExternalChannel = Exclude<NotificationChannel, 'in_app'>;

export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'skipped'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Who a resolved recipient is relative to the event. Trigger rules choose which types are notified.
 * `user` = explicit user ids, `student` = the student concerned, `guardian` = their parents/guardians,
 * `staff` = institute staff (teachers, admins, accountants…).
 */
export const RECIPIENT_TYPES = ['user', 'student', 'guardian', 'staff'] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

export const MESSAGING_PROVIDER_KINDS = {
  console: { label: 'Console / mock (development)', channels: ['sms', 'whatsapp', 'email', 'push'] },
  msg91: { label: 'MSG91', channels: ['sms', 'whatsapp'] },
  twilio: { label: 'Twilio', channels: ['sms', 'whatsapp'] },
  'whatsapp-cloud': { label: 'WhatsApp Cloud API (Meta)', channels: ['whatsapp'] },
  smtp: { label: 'SMTP', channels: ['email'] },
  fcm: { label: 'Firebase Cloud Messaging', channels: ['push'] },
} as const satisfies Record<string, { label: string; channels: readonly ExternalChannel[] }>;
export type MessagingProviderKind = keyof typeof MESSAGING_PROVIDER_KINDS;

/** Credential fields per provider; `secret` fields are encrypted at rest and never returned. */
export const PROVIDER_FIELDS: Record<
  MessagingProviderKind,
  { key: string; label: string; secret?: boolean; required?: boolean }[]
> = {
  console: [{ key: 'failPattern', label: 'Fail when recipient contains (testing)' }],
  msg91: [
    { key: 'authKey', label: 'Auth key', secret: true, required: true },
    { key: 'senderId', label: 'Sender id', required: true },
    { key: 'dltEntityId', label: 'DLT entity id' },
  ],
  twilio: [
    { key: 'accountSid', label: 'Account SID', required: true },
    { key: 'authToken', label: 'Auth token', secret: true, required: true },
    { key: 'from', label: 'From number', required: true },
  ],
  'whatsapp-cloud': [
    { key: 'phoneNumberId', label: 'Phone number id', required: true },
    { key: 'accessToken', label: 'Access token', secret: true, required: true },
    { key: 'businessAccountId', label: 'Business account id' },
  ],
  smtp: [
    { key: 'host', label: 'Host', required: true },
    { key: 'port', label: 'Port', required: true },
    { key: 'secure', label: 'TLS (true/false)' },
    { key: 'user', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'from', label: 'From address', required: true },
  ],
  fcm: [
    { key: 'projectId', label: 'Project id', required: true },
    { key: 'clientEmail', label: 'Service account email', required: true },
    { key: 'privateKey', label: 'Service account private key', secret: true, required: true },
  ],
};

export interface NotificationEventDef {
  /** `<module>.<event>`, e.g. `fees.receipt`. */
  key: string;
  label: string;
  category: string;
  /** Template variables available in `{{ }}` (besides `recipient.name` and `institute.name`). */
  variables: string[];
  defaultChannels: NotificationChannel[];
  defaultRecipientTypes: RecipientType[];
  /** Default template used when the institute has none for a channel. */
  title: string;
  body: string;
  /** Mandatory events ignore user opt-outs (e.g. security notices). */
  mandatory?: boolean;
}

const ev = (
  key: string,
  label: string,
  category: string,
  variables: string[],
  title: string,
  body: string,
  defaultRecipientTypes: RecipientType[] = ['student', 'guardian'],
  defaultChannels: NotificationChannel[] = ['in_app', 'push'],
): NotificationEventDef => ({
  key,
  label,
  category,
  variables,
  title,
  body,
  defaultChannels,
  defaultRecipientTypes,
});

/** Platform event catalogue. Modules may add more at runtime with `registerNotificationEvents()`. */
export const NOTIFICATION_EVENTS: NotificationEventDef[] = [
  ev(
    'registration.welcome',
    'Registration / welcome',
    'Admissions',
    ['student.name', 'loginId'],
    'Welcome to {{institute.name}}',
    'Hi {{recipient.name}}, {{student.name}} is now registered with {{institute.name}}. Login id: {{loginId}}.',
    ['student', 'guardian'],
    ['in_app', 'sms', 'email'],
  ),
  ev(
    'admissions.confirmed',
    'Admission confirmed',
    'Admissions',
    ['student.name', 'course', 'batch'],
    'Admission confirmed',
    'Admission of {{student.name}} to {{course}} ({{batch}}) is confirmed.',
    ['student', 'guardian'],
    ['in_app', 'sms', 'whatsapp'],
  ),
  ev(
    'fees.due',
    'Fee due reminder',
    'Fees',
    ['student.name', 'amount', 'dueDate'],
    'Fee due',
    'Fee of ₹{{amount}} for {{student.name}} is due on {{dueDate}}.',
    ['guardian', 'student'],
    ['in_app', 'push', 'sms', 'whatsapp'],
  ),
  ev(
    'fees.overdue',
    'Fee overdue',
    'Fees',
    ['student.name', 'amount', 'dueDate'],
    'Fee overdue',
    'Fee of ₹{{amount}} for {{student.name}} was due on {{dueDate}} and is now overdue.',
    ['guardian'],
    ['in_app', 'push', 'sms', 'whatsapp'],
  ),
  ev(
    'fees.receipt',
    'Fee receipt',
    'Fees',
    ['student.name', 'amount', 'receiptNo', 'paidOn'],
    'Payment received',
    'Received ₹{{amount}} for {{student.name}} on {{paidOn}}. Receipt {{receiptNo}}.',
    ['guardian', 'student'],
    ['in_app', 'push', 'sms', 'email'],
  ),
  ev(
    'attendance.absent',
    'Absent alert',
    'Attendance',
    ['student.name', 'date', 'batch'],
    'Absent today',
    '{{student.name}} was marked absent in {{batch}} on {{date}}.',
    ['guardian'],
    ['in_app', 'push', 'sms'],
  ),
  ev(
    'exams.scheduled',
    'Exam scheduled',
    'Exams',
    ['exam', 'date', 'batch'],
    'Exam scheduled',
    '{{exam}} for {{batch}} is scheduled on {{date}}.',
  ),
  ev(
    'exams.reminder',
    'Exam reminder',
    'Exams',
    ['exam', 'date'],
    'Exam reminder',
    'Reminder: {{exam}} starts on {{date}}.',
  ),
  ev(
    'results.published',
    'Results published',
    'Exams',
    ['student.name', 'exam', 'score'],
    'Result published',
    'Result of {{exam}} for {{student.name}}: {{score}}.',
    ['student', 'guardian'],
    ['in_app', 'push', 'sms'],
  ),
  ev(
    'classes.rescheduled',
    'Class rescheduled',
    'Classes',
    ['subject', 'batch', 'from', 'to'],
    'Class rescheduled',
    '{{subject}} ({{batch}}) moved from {{from}} to {{to}}.',
  ),
  ev(
    'classes.cancelled',
    'Class cancelled',
    'Classes',
    ['subject', 'batch', 'date'],
    'Class cancelled',
    '{{subject}} ({{batch}}) on {{date}} is cancelled.',
  ),
  ev(
    'live-classes.scheduled',
    'Live class scheduled',
    'Live classes',
    ['title', 'startsAt'],
    'Live class scheduled',
    'Live class "{{title}}" starts at {{startsAt}}.',
  ),
  ev(
    'live-classes.starting',
    'Live class starting',
    'Live classes',
    ['title', 'joinUrl'],
    'Live class starting',
    '"{{title}}" is starting now. Join from the app.',
    ['student'],
  ),
  ev(
    'homework.assigned',
    'Homework assigned',
    'Homework',
    ['title', 'subject', 'dueDate'],
    'New homework',
    '{{subject}}: {{title}} — due {{dueDate}}.',
  ),
  ev(
    'homework.due',
    'Homework due reminder',
    'Homework',
    ['title', 'dueDate'],
    'Homework due',
    '"{{title}}" is due on {{dueDate}}.',
    ['student'],
  ),
  ev(
    'grievances.created',
    'Grievance submitted',
    'Grievances',
    ['ticketNo', 'subject'],
    'Grievance {{ticketNo}} received',
    'Your grievance "{{subject}}" was registered as {{ticketNo}}.',
    ['user', 'staff'],
  ),
  ev(
    'grievances.updated',
    'Grievance updated',
    'Grievances',
    ['ticketNo', 'status'],
    'Grievance {{ticketNo}} updated',
    'Grievance {{ticketNo}} is now {{status}}.',
    ['user'],
  ),
  ev(
    'grievances.resolved',
    'Grievance resolved',
    'Grievances',
    ['ticketNo', 'resolution'],
    'Grievance {{ticketNo}} resolved',
    'Grievance {{ticketNo}} was resolved: {{resolution}}',
    ['user'],
    ['in_app', 'push', 'sms'],
  ),
  ev(
    'appointments.requested',
    'Appointment requested',
    'Appointments',
    ['requester', 'date', 'time'],
    'Meeting request',
    '{{requester}} requested a meeting on {{date}} at {{time}}.',
    ['staff', 'user'],
  ),
  ev(
    'appointments.confirmed',
    'Appointment confirmed',
    'Appointments',
    ['teacher', 'date', 'time', 'mode'],
    'Meeting confirmed',
    'Your meeting with {{teacher}} on {{date}} at {{time}} ({{mode}}) is confirmed.',
    ['user', 'guardian'],
  ),
  ev(
    'appointments.cancelled',
    'Appointment cancelled',
    'Appointments',
    ['teacher', 'date', 'time'],
    'Meeting cancelled',
    'The meeting with {{teacher}} on {{date}} at {{time}} was cancelled.',
    ['user', 'guardian'],
  ),
  ev(
    'appointments.reminder',
    'Appointment reminder',
    'Appointments',
    ['teacher', 'date', 'time'],
    'Meeting reminder',
    'Reminder: meeting with {{teacher}} on {{date}} at {{time}}.',
    ['user', 'guardian', 'staff'],
  ),
  ev(
    'announcements.general',
    'Announcement (bulk / compose)',
    'Announcements',
    ['title', 'message'],
    '{{title}}',
    '{{message}}',
    ['user'],
    ['in_app', 'push'],
  ),
];

/** The event used for bulk / composed messages. */
export const ANNOUNCEMENT_EVENT = 'announcements.general';

export interface NotificationProviderDto {
  channel: ExternalChannel;
  provider: MessagingProviderKind;
  isActive: boolean;
  /** Non-secret settings plus masked hints for secrets (e.g. `AQ….Sf9Q`). */
  settings: Record<string, string>;
  secretHints: Record<string, string>;
  retryMaxAttempts: number;
  retryBaseDelaySeconds: number;
  updatedAt: string | null;
}

export interface NotificationTemplateDto {
  id: number;
  eventKey: string;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  providerTemplateId: string | null;
  isActive: boolean;
}

export interface NotificationRuleDto {
  eventKey: string;
  channels: NotificationChannel[];
  recipientTypes: RecipientType[];
  isActive: boolean;
  /** true when no institute override exists and catalogue defaults apply. */
  isDefault: boolean;
}

export interface NotificationMessageDto {
  id: number;
  eventKey: string;
  channel: NotificationChannel;
  userId: number | null;
  recipientName: string | null;
  recipientAddress: string | null;
  subject: string | null;
  body: string;
  status: MessageStatus;
  provider: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  campaignId: number | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface DeliveryAttemptDto {
  id: number;
  attemptNo: number;
  status: 'sent' | 'delivered' | 'failed';
  provider: string;
  providerMessageId: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface InboxItemDto {
  id: number;
  eventKey: string;
  title: string | null;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferenceDto {
  channel: NotificationChannel;
  /** null = applies to every event on the channel (channel-level consent). */
  eventKey: string | null;
  enabled: boolean;
}

export type CampaignStatus = 'scheduled' | 'processing' | 'sent' | 'cancelled' | 'failed';

export interface CampaignAudience {
  /** Restrict to these branches (users with a role or membership in them). */
  branchIds?: number[];
  /** System/custom role slugs, e.g. `student`, `parent`, `teacher`. */
  roles?: string[];
  /** Batch ids, resolved by the batches module via a recipient resolver. */
  batchIds?: number[];
  userIds?: number[];
}

export interface CampaignDto {
  id: number;
  title: string;
  channels: NotificationChannel[];
  subject: string | null;
  body: string;
  audience: CampaignAudience;
  scheduledAt: string | null;
  status: CampaignStatus;
  recipientCount: number;
  messageCount: number;
  createdBy: number | null;
  createdAt: string;
}
