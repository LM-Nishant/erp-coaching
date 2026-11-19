import { config } from '../config';
import { logger } from '../logger';
import { ConsoleMessagingProvider } from './console.provider';
import type { Channel, MessagingProvider, ProviderSettings } from './types';
import { whatsappVerifyToken } from './webhooks';

export * from './types';
export { consoleOutbox } from './console.provider';
export * from './providers';
export * from './errors';
export * from './webhooks';
export { isApnsToken } from './apns';
export { e164, msisdn, storedMobileForms } from './phone';
export { otpSms } from './otp';
export { setMessagingTransport, type Http2Response, type Mailer, type MessagingTransport } from './transport';

const providers = new Map<Channel, MessagingProvider>();

/**
 * Built-in provider for a channel (console: logs instead of sending). Vendor providers are chosen
 * per institute (notifications module) or for the platform (super admin), see `createMessagingProvider`.
 */
export function getMessagingProvider(channel: Channel): MessagingProvider {
  let p = providers.get(channel);
  if (!p) {
    p = new ConsoleMessagingProvider(channel);
    providers.set(channel, p);
  }
  return p;
}

export function setMessagingProvider(provider: MessagingProvider): void {
  providers.set(provider.channel, provider);
}

/** Supplies the super admin's global provider for a channel; null = not configured/enabled. */
export type DefaultMessagingResolver = (channel: Channel) => Promise<MessagingProvider | null>;

let defaultResolver: DefaultMessagingResolver | null = null;

/** Registered by the platform module (global notification provider settings). */
export function setDefaultMessagingResolver(fn: DefaultMessagingResolver | null): void {
  defaultResolver = fn;
}

/**
 * Platform default provider for a channel: the globally configured provider when enabled, else the
 * built-in provider above. Institute-specific providers (notifications module) take precedence.
 */
export async function getDefaultMessagingProvider(channel: Channel): Promise<MessagingProvider> {
  if (defaultResolver) {
    try {
      const provider = await defaultResolver(channel);
      if (provider) return provider;
    } catch (err) {
      logger.error({ err, channel }, 'Global messaging provider unavailable; using the built-in provider');
    }
  }
  return getMessagingProvider(channel);
}

/** Vendors that report delivery status (and inbound replies) to a webhook. */
export const MESSAGING_WEBHOOK_VENDORS = ['msg91', 'twilio', 'whatsapp-cloud'] as const;
export const hasMessagingWebhook = (kind: string) =>
  (MESSAGING_WEBHOOK_VENDORS as readonly string[]).includes(kind);

/** Public webhook URL the admin pastes into the vendor dashboard (key = provider webhook key). */
export function messagingWebhookUrl(vendor: string, webhookKey: string): string {
  return `${config.API_PUBLIC_URL.replace(/\/+$/, '')}/api/notifications/public/webhooks/${vendor}/${webhookKey}`;
}

/** What the admin pastes into the vendor dashboard; undefined for vendors without webhooks. */
export function messagingWebhook(
  vendor: string,
  webhookKey: string | null | undefined,
): { url: string; verifyToken?: string } | undefined {
  if (!webhookKey || !hasMessagingWebhook(vendor)) return undefined;
  return {
    url: messagingWebhookUrl(vendor, webhookKey),
    ...(vendor === 'whatsapp-cloud' ? { verifyToken: whatsappVerifyToken(webhookKey) } : {}),
  };
}

export interface WebhookProviderMatch {
  channel: Channel;
  kind: string;
  settings: ProviderSettings;
}

/** Finds the platform provider that owns a webhook key; registered by the platform module. */
export type PlatformWebhookResolver = (
  vendor: string,
  webhookKey: string,
) => Promise<WebhookProviderMatch | null>;

let platformWebhookResolver: PlatformWebhookResolver | null = null;

export function setPlatformWebhookResolver(fn: PlatformWebhookResolver | null): void {
  platformWebhookResolver = fn;
}

export async function resolvePlatformWebhook(
  vendor: string,
  webhookKey: string,
): Promise<WebhookProviderMatch | null> {
  return platformWebhookResolver ? platformWebhookResolver(vendor, webhookKey) : null;
}
