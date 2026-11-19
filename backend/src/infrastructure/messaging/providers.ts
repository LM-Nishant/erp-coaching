import { ConsoleMessagingProvider } from './console.provider';
import { FcmProvider } from './fcm';
import { Msg91Provider } from './msg91';
import { SmtpProvider } from './smtp';
import { TwilioProvider } from './twilio';
import type { Channel, MessagingProvider, ProviderOptions, ProviderSettings } from './types';
import { WhatsAppCloudProvider } from './whatsapp-cloud';

export type { ProviderSettings } from './types';
export { FcmProvider, Msg91Provider, SmtpProvider, TwilioProvider, WhatsAppCloudProvider };

/**
 * Builds the adapter for a provider kind (`MESSAGING_PROVIDER_KINDS`) from decrypted settings.
 * Vendor adapters call the vendor APIs through `transport.ts`; the console provider only logs.
 */
export function createMessagingProvider(
  kind: string,
  channel: Channel,
  settings: ProviderSettings = {},
  options: ProviderOptions = {},
): MessagingProvider {
  switch (kind) {
    case 'console':
      return new ConsoleMessagingProvider(channel, { failPattern: settings.failPattern || undefined });
    case 'msg91':
      return new Msg91Provider(channel, settings);
    case 'twilio':
      return new TwilioProvider(channel, settings, options);
    case 'whatsapp-cloud':
      return new WhatsAppCloudProvider(channel, settings);
    case 'smtp':
      return new SmtpProvider(channel, settings);
    case 'fcm':
      return new FcmProvider(channel, settings);
    default:
      throw new Error(`Unknown messaging provider: ${kind}`);
  }
}
