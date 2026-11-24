import type {
  ExternalChannel,
  IntegrationTestResultDto,
  IntegrationTestStatus,
  LiveStreamingStatusDto,
  LiveStreamingTestResultDto,
  PaymentGatewayKey,
  PlatformGatewayDto,
  PlatformGatewayInput,
  PlatformIntegrationsDto,
  PlatformMessagingDto,
  PlatformMessagingInput,
  PlatformStorageDto,
  PlatformStorageInput,
  StorageDriverKey,
} from '@erp/shared';
import { api } from '@/core/api';
import { i18n } from '@/i18n';

const t = (key: string) => i18n.global.t(key);

const base = '/admin/platform';

/** Super admin global configuration (payment gateways, notification providers, storage). */
export const platformApi = {
  integrations: () => api.get<PlatformIntegrationsDto>(`${base}/integrations`),
  saveGateway: (gateway: string, b: PlatformGatewayInput) =>
    api.put<PlatformGatewayDto>(`${base}/gateways/${gateway}`, b),
  testGateway: (gateway: string, b: Partial<PlatformGatewayInput>) =>
    api.post<IntegrationTestResultDto>(`${base}/gateways/${gateway}/test`, b),
  removeGateway: (gateway: string) => api.delete<PlatformGatewayDto>(`${base}/gateways/${gateway}`),
  saveMessaging: (channel: ExternalChannel, b: PlatformMessagingInput) =>
    api.put<PlatformMessagingDto>(`${base}/messaging/${channel}`, b),
  testMessaging: (
    channel: ExternalChannel,
    b: Partial<Pick<PlatformMessagingInput, 'provider' | 'settings'>> & {
      to: string;
      templateId?: string;
    },
  ) => api.post<IntegrationTestResultDto>(`${base}/messaging/${channel}/test`, b),
  verifyMessaging: (
    channel: ExternalChannel,
    b: Partial<Pick<PlatformMessagingInput, 'provider' | 'settings'>>,
  ) => api.post<IntegrationTestResultDto>(`${base}/messaging/${channel}/verify`, b),
  removeMessaging: (channel: ExternalChannel) =>
    api.delete<PlatformMessagingDto>(`${base}/messaging/${channel}`),
  saveStorage: (b: PlatformStorageInput) => api.put<PlatformStorageDto>(`${base}/storage`, b),
  testStorage: (b: Partial<PlatformStorageInput>) =>
    api.post<IntegrationTestResultDto>(`${base}/storage/test`, b),
  /** Live-class media provider (configured on the server): status, webhook URL and connection check. */
  liveStreaming: () => api.get<LiveStreamingStatusDto>('/admin/live-streaming'),
  testLiveStreaming: () => api.post<LiveStreamingTestResultDto>('/admin/live-streaming/test', {}),
};

export const gatewayLabel = (k: string): string =>
  ({
    mock: t('platform.labels.mockGateway'),
    paytm: 'Paytm',
    razorpay: 'Razorpay',
    cashfree: 'Cashfree',
  })[k as PaymentGatewayKey] ?? k;

export const channelLabel = (c: ExternalChannel): string =>
  ({
    sms: 'SMS',
    whatsapp: 'WhatsApp',
    email: t('platform.labels.email'),
    push: t('platform.labels.push'),
  })[c] ?? c;

export const storageLabel = (d: string): string =>
  ({
    local: t('platform.labels.localDisk'),
    s3: 'Amazon S3',
    r2: 'Cloudflare R2',
  })[d as StorageDriverKey] ?? d;

/** The latest test outcome to show: a test run on this screen, else the saved configuration's. */
export function lastTest(
  status: IntegrationTestStatus,
  result: IntegrationTestResultDto | null,
): { ok: boolean; message: string; at: string } | null {
  if (result) return { ok: result.ok, message: result.message, at: result.testedAt };
  if (!status.lastTestedAt) return null;
  return { ok: !!status.lastTestOk, message: status.lastTestMessage ?? '', at: status.lastTestedAt };
}
