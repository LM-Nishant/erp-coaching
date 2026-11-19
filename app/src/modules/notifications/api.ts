import type {
  CampaignAudience,
  CampaignDto,
  DeliveryAttemptDto,
  ExternalChannel,
  InboxItemDto,
  MessageStatus,
  MessagingProviderKind,
  NotificationChannel,
  NotificationEventDef,
  NotificationMessageDto,
  NotificationPreferenceDto,
  NotificationProviderDto,
  NotificationRuleDto,
  NotificationTemplateDto,
  ProviderVerifyResultDto,
  RecipientType,
} from '@erp/shared';
import { api } from '@/core/api';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TemplateInput {
  eventKey: string;
  channel: NotificationChannel;
  subject?: string | null;
  body: string;
  providerTemplateId?: string | null;
  isActive?: boolean;
}

export interface ProviderInput {
  provider: MessagingProviderKind;
  isActive: boolean;
  settings: Record<string, string>;
  retryMaxAttempts?: number;
  retryBaseDelaySeconds?: number;
}

export interface CampaignInput {
  title: string;
  channels: NotificationChannel[];
  subject?: string | null;
  body: string;
  audience: CampaignAudience;
  scheduledAt?: string | null;
}

export interface HistoryFilter {
  page?: number;
  pageSize?: number;
  status?: MessageStatus;
  channel?: NotificationChannel;
  eventKey?: string;
  campaignId?: number;
}

const base = '/notifications';

/** Current user's inbox, preferences and devices. */
export const inboxApi = {
  list: (q: { page?: number; unreadOnly?: boolean } = {}) =>
    api.get<Page<InboxItemDto> & { unread: number }>(`${base}/inbox`, q),
  /** Polled by the bell: a background request, so it does not count as activity for inactivity logout. */
  unreadCount: () =>
    api.get<{ unread: number }>(`${base}/inbox/unread-count`, undefined, { background: true }),
  markRead: (id: number) => api.post<InboxItemDto>(`${base}/inbox/${id}/read`),
  markAllRead: () => api.post<{ updated: number }>(`${base}/inbox/read-all`),
  preferences: () => api.get<NotificationPreferenceDto[]>(`${base}/preferences`),
  savePreferences: (preferences: NotificationPreferenceDto[]) =>
    api.put<NotificationPreferenceDto[]>(`${base}/preferences`, { preferences }),
  registerPushToken: (body: {
    token: string;
    platform: 'web' | 'android' | 'ios';
    deviceUid?: string | null;
  }) => api.post<{ id: number }>(`${base}/push-tokens`, body),
  removePushToken: (token: string) => api.delete(`${base}/push-tokens`, { body: { token } }),
};

/** Institute admin: providers, templates, rules, campaigns, delivery history. */
export const commsApi = {
  events: () => api.get<NotificationEventDef[]>(`${base}/events`),

  providers: () => api.get<NotificationProviderDto[]>(`${base}/providers`),
  saveProvider: (channel: ExternalChannel, body: ProviderInput) =>
    api.put<NotificationProviderDto>(`${base}/providers/${channel}`, body),
  resetProvider: (channel: ExternalChannel) =>
    api.delete<NotificationProviderDto>(`${base}/providers/${channel}`),
  testProvider: (channel: ExternalChannel, to: string, opts: { templateId?: string; body?: string } = {}) =>
    api.post<{ ok: boolean; provider: string; error?: string }>(`${base}/providers/${channel}/test`, {
      to,
      ...opts,
    }),
  verifyProvider: (channel: ExternalChannel) =>
    api.post<ProviderVerifyResultDto>(`${base}/providers/${channel}/verify`, {}),

  templates: () => api.get<NotificationTemplateDto[]>(`${base}/templates`),
  createTemplate: (t: TemplateInput) => api.post<NotificationTemplateDto>(`${base}/templates`, t),
  updateTemplate: (id: number, t: Partial<TemplateInput>) =>
    api.patch<NotificationTemplateDto>(`${base}/templates/${id}`, t),
  removeTemplate: (id: number) => api.delete(`${base}/templates/${id}`),
  preview: (body: { eventKey: string; subject?: string | null; body: string }) =>
    api.post<{ subject: string | null; body: string }>(`${base}/templates/preview`, body),

  rules: () => api.get<NotificationRuleDto[]>(`${base}/rules`),
  saveRule: (
    eventKey: string,
    body: { channels: NotificationChannel[]; recipientTypes: RecipientType[]; isActive: boolean },
  ) => api.put<NotificationRuleDto>(`${base}/rules/${eventKey}`, body),
  resetRule: (eventKey: string) => api.delete<NotificationRuleDto>(`${base}/rules/${eventKey}`),

  messages: (q: HistoryFilter) => api.get<Page<NotificationMessageDto>>(`${base}/messages`, { ...q }),
  message: (id: number) =>
    api.get<NotificationMessageDto & { deliveryAttempts: DeliveryAttemptDto[] }>(`${base}/messages/${id}`),
  retry: (id: number) => api.post<NotificationMessageDto>(`${base}/messages/${id}/retry`),

  campaigns: () => api.get<Page<CampaignDto>>(`${base}/campaigns`, { pageSize: 50 }),
  createCampaign: (c: CampaignInput) => api.post<CampaignDto>(`${base}/campaigns`, c),
  cancelCampaign: (id: number) => api.post<CampaignDto>(`${base}/campaigns/${id}/cancel`),
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: 'In-app',
  push: 'Push',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  email: 'Email',
};

export const STATUS_COLORS: Record<MessageStatus, string> = {
  queued: 'warning',
  sent: 'primary',
  delivered: 'success',
  failed: 'danger',
  skipped: 'medium',
};

export const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
