import type {
  ExternalChannel,
  IntegrationTestResultDto,
  IntegrationTestStatus,
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
};

export const GATEWAY_LABELS: Record<PaymentGatewayKey, string> = {
  mock: 'Mock gateway (testing)',
  paytm: 'Paytm',
  razorpay: 'Razorpay',
  cashfree: 'Cashfree',
};

export const CHANNEL_LABELS: Record<ExternalChannel, string> = {
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  email: 'Email',
  push: 'Push notifications',
};

export const STORAGE_LABELS: Record<StorageDriverKey, string> = {
  local: 'Local disk',
  s3: 'Amazon S3',
  r2: 'Cloudflare R2',
};

/** The latest test outcome to show: a test run on this screen, else the saved configuration's. */
export function lastTest(
  status: IntegrationTestStatus,
  result: IntegrationTestResultDto | null,
): { ok: boolean; message: string; at: string } | null {
  if (result) return { ok: result.ok, message: result.message, at: result.testedAt };
  if (!status.lastTestedAt) return null;
  return { ok: !!status.lastTestOk, message: status.lastTestMessage ?? '', at: status.lastTestedAt };
}
