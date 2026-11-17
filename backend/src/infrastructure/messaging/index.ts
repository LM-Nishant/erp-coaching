import { ConsoleMessagingProvider } from './console.provider';
import type { Channel, MessagingProvider } from './types';

export * from './types';
export { consoleOutbox } from './console.provider';

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
