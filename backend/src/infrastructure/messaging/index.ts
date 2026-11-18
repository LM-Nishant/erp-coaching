import { logger } from '../logger';
import { ConsoleMessagingProvider } from './console.provider';
import type { Channel, MessagingProvider } from './types';

export * from './types';
export { consoleOutbox } from './console.provider';
export * from './providers';

const providers = new Map<Channel, MessagingProvider>();

/**
 * Returns the configured provider for a channel. Only console providers exist today; real
 * providers (MSG91, Twilio, Meta WhatsApp, SES, FCM...) implement MessagingProvider and are
 * selected here via env (SMS_PROVIDER etc.) or per-institute settings later.
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
