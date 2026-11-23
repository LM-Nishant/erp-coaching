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
  fcm: { label: 'Firebase Cloud Messaging (+ APNs for iOS)', channels: ['push'] },
} as const satisfies Record<string, { label: string; channels: readonly ExternalChannel[] }>;
export type MessagingProviderKind = keyof typeof MESSAGING_PROVIDER_KINDS;

export interface ProviderField {
  key: string;
  label: string;
  /** Encrypted at rest and never returned; a blank value on save keeps the stored one. */
  secret?: boolean;
  required?: boolean;
  /** Only used on these channels (default: every channel of the provider). */
  channels?: readonly ExternalChannel[];
  /** Only for the platform default provider (e.g. the login OTP template). */
  platformOnly?: boolean;
  help?: string;
  placeholder?: string;
  /** Multi-line value (PEM keys). */
  multiline?: boolean;
  /** Fixed choices; blank uses the vendor default. */
  options?: readonly { value: string; label: string }[];
}

const WHATSAPP_OPT_IN: ProviderField = {
  key: 'requireOptIn',
  label: 'Require WhatsApp opt-in',
  channels: ['whatsapp'],
  options: [
    { value: 'yes', label: 'Yes: only users who opted in' },
    { value: 'no', label: 'No: consent collected elsewhere' },
  ],
  help: 'WhatsApp policy: message only users who agreed to receive WhatsApp messages from you.',
};

const TEMPLATE_LANGUAGE: ProviderField = {
  key: 'defaultLanguage',
  label: 'Template language',
  channels: ['whatsapp'],
  placeholder: 'en',
  help: 'Language code of your approved templates (a template id like `fee_receipt:hi` overrides it).',
};

/** Credential fields per provider (see docs/integrations/messaging.md for where to find each one). */
export const PROVIDER_FIELDS: Record<MessagingProviderKind, ProviderField[]> = {
  console: [{ key: 'failPattern', label: 'Fail when recipient contains (testing)' }],
  msg91: [
    { key: 'authKey', label: 'Auth key', secret: true, required: true },
    {
      key: 'senderId',
      label: 'Sender id (DLT header)',
      required: true,
      channels: ['sms'],
      placeholder: 'APEXED',
    },
    {
      key: 'dltEntityId',
      label: 'DLT principal entity id',
      channels: ['sms'],
      help: 'India: the entity id of your DLT registration.',
    },
    {
      key: 'otpTemplateId',
      label: 'Login OTP template id',
      required: true,
      channels: ['sms'],
      platformOnly: true,
      help: 'DLT template id (text: "{#var#} is your verification code. It expires in {#var#} minutes.") or an MSG91 template id using ##otp## and ##minutes##.',
    },
    {
      key: 'integratedNumber',
      label: 'WhatsApp integrated number',
      required: true,
      channels: ['whatsapp'],
      placeholder: '919876543210',
    },
    TEMPLATE_LANGUAGE,
    WHATSAPP_OPT_IN,
  ],
  twilio: [
    {
      key: 'accountSid',
      label: 'Account SID',
      required: true,
      placeholder: 'AC…',
      help: 'Test credentials work for SMS sandbox testing.',
    },
    { key: 'authToken', label: 'Auth token', secret: true, required: true },
    {
      key: 'from',
      label: 'From number or Messaging Service SID',
      required: true,
      placeholder: '+15551234567 or MG…',
    },
    WHATSAPP_OPT_IN,
  ],
  'whatsapp-cloud': [
    { key: 'phoneNumberId', label: 'Phone number id', required: true },
    {
      key: 'accessToken',
      label: 'Access token',
      secret: true,
      required: true,
      help: 'A permanent System User token with whatsapp_business_messaging.',
    },
    {
      key: 'appSecret',
      label: 'App secret',
      secret: true,
      required: true,
      help: 'Meta app secret: verifies the X-Hub-Signature-256 of delivery webhooks.',
    },
    { key: 'businessAccountId', label: 'Business account id' },
    { key: 'apiVersion', label: 'Graph API version', placeholder: 'v27.0' },
    TEMPLATE_LANGUAGE,
    WHATSAPP_OPT_IN,
  ],
  smtp: [
    { key: 'host', label: 'Host', required: true, placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', required: true, placeholder: '587' },
    {
      key: 'secure',
      label: 'Connection security',
      options: [
        { value: 'false', label: 'STARTTLS (port 587)' },
        { value: 'true', label: 'TLS (port 465)' },
      ],
    },
    { key: 'user', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'from', label: 'From address', required: true, placeholder: 'Institute <noreply@example.com>' },
  ],
  fcm: [
    { key: 'projectId', label: 'Firebase project id', required: true },
    { key: 'clientEmail', label: 'Service account email', required: true },
    {
      key: 'privateKey',
      label: 'Service account private key',
      secret: true,
      required: true,
      multiline: true,
      help: 'The private_key of the service account JSON (-----BEGIN PRIVATE KEY-----…).',
    },
    {
      key: 'apnsKeyId',
      label: 'APNs key id (iOS)',
      help: 'iOS devices register APNs tokens: fill the APNs fields to deliver to iPhones.',
    },
    { key: 'apnsTeamId', label: 'Apple team id' },
    { key: 'apnsBundleId', label: 'iOS bundle id', placeholder: 'com.example.app' },
    {
      key: 'apnsPrivateKey',
      label: 'APNs auth key (.p8)',
      secret: true,
      multiline: true,
    },
    {
      key: 'apnsEnvironment',
      label: 'APNs environment',
      options: [
        { value: 'production', label: 'Production (App Store, TestFlight)' },
        { value: 'sandbox', label: 'Sandbox (debug builds from Xcode)' },
      ],
    },
  ],
};

/** The fields that apply to a provider on a channel (platform defaults also have platform-only fields). */
export function providerFieldsFor(
  kind: MessagingProviderKind,
  channel: ExternalChannel,
  opts: { platform?: boolean } = {},
): ProviderField[] {
  return (PROVIDER_FIELDS[kind] ?? []).filter(
    (f) => (!f.channels || f.channels.includes(channel)) && (!f.platformOnly || !!opts.platform),
  );
}

/** Where the vendor posts delivery reports and replies (paste into the vendor dashboard). */
export interface MessagingWebhookDto {
  url: string;
  /** WhatsApp Cloud API: the verify token of the webhook subscription. */
  verifyToken?: string;
}

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
    'admissions.follow-up-due',
    'Enquiry follow-up reminder (counsellor)',
    'Admissions',
    ['enquiry.name', 'enquiry.mobile', 'when', 'note'],
    'Follow-up due: {{enquiry.name}}',
    'Reminder: follow up with {{enquiry.name}} ({{enquiry.mobile}}) at {{when}} UTC. {{note}}',
    ['user'],
    ['in_app', 'sms'],
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
    'classes.substituted',
    'Substitute teacher',
    'Classes',
    ['subject', 'batch', 'date', 'teacher'],
    'Substitute teacher',
    '{{subject}} ({{batch}}) on {{date}} will be taken by {{teacher}}.',
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
    'live-classes.reminder',
    'Live class reminder',
    'Live classes',
    ['title', 'minutes', 'joinUrl'],
    'Live class soon',
    '"{{title}}" starts in {{minutes}} minutes. Tap to join.',
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
    'grievances.activity',
    'Grievance activity (assignment, reply, reopen, SLA)',
    'Grievances',
    ['title', 'message', 'ticketId'],
    '{{title}}',
    '{{message}}',
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
  /** Saved vendor providers that report delivery status. */
  webhook?: MessagingWebhookDto;
}

/** Result of checking saved provider credentials with the vendor (nothing is sent). */
export interface ProviderVerifyResultDto {
  ok: boolean;
  provider: string;
  message: string;
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
