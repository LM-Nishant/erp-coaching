import { ConsoleMessagingProvider } from './console.provider';
import type { Channel, MessagingProvider, OutboundMessage, SendResult } from './types';

/**
 * Vendor adapters selected per institute (see the notifications module's provider settings).
 * Each adapter receives decrypted settings and implements `MessagingProvider`. Only the console
 * provider sends today; the vendor classes define the configuration contract and will be wired to
 * the vendor HTTP APIs when credentials are available.
 */
export type ProviderSettings = Record<string, string>;

export class ProviderNotImplementedError extends Error {
  constructor(provider: string) {
    super(`Messaging provider "${provider}" is not implemented yet`);
  }
}

abstract class VendorProvider<S> implements MessagingProvider {
  abstract readonly name: string;
  constructor(
    readonly channel: Channel,
    protected readonly settings: S,
  ) {}
  async send(_message: OutboundMessage): Promise<SendResult> {
    throw new ProviderNotImplementedError(this.name);
  }
}

/** MSG91 SMS (DLT template id via `OutboundMessage.templateId`) and WhatsApp. */
export interface Msg91Settings {
  authKey: string;
  senderId: string;
  dltEntityId?: string;
}
export class Msg91Provider extends VendorProvider<Msg91Settings> {
  readonly name = 'msg91';
}

/** Twilio Programmable Messaging (SMS, and WhatsApp via `whatsapp:` prefixed numbers). */
export interface TwilioSettings {
  accountSid: string;
  authToken: string;
  from: string;
}
export class TwilioProvider extends VendorProvider<TwilioSettings> {
  readonly name = 'twilio';
}

/** Meta WhatsApp Cloud API; approved template name via `OutboundMessage.templateId`. */
export interface WhatsAppCloudSettings {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId?: string;
}
export class WhatsAppCloudProvider extends VendorProvider<WhatsAppCloudSettings> {
  readonly name = 'whatsapp-cloud';
}

export interface SmtpSettings {
  host: string;
  port: string;
  secure?: string;
  user?: string;
  password?: string;
  from: string;
}
export class SmtpProvider extends VendorProvider<SmtpSettings> {
  readonly name = 'smtp';
}

/** Firebase Cloud Messaging HTTP v1; `to` is the device registration token. */
export interface FcmSettings {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}
export class FcmProvider extends VendorProvider<FcmSettings> {
  readonly name = 'fcm';
}

/** Builds a provider instance for a channel from (decrypted) institute settings. */
export function createMessagingProvider(
  kind: string,
  channel: Channel,
  settings: ProviderSettings = {},
): MessagingProvider {
  switch (kind) {
    case 'console':
      return new ConsoleMessagingProvider(channel, { failPattern: settings.failPattern || undefined });
    case 'msg91':
      return new Msg91Provider(channel, settings as unknown as Msg91Settings);
    case 'twilio':
      return new TwilioProvider(channel, settings as unknown as TwilioSettings);
    case 'whatsapp-cloud':
      return new WhatsAppCloudProvider(channel, settings as unknown as WhatsAppCloudSettings);
    case 'smtp':
      return new SmtpProvider(channel, settings as unknown as SmtpSettings);
    case 'fcm':
      return new FcmProvider(channel, settings as unknown as FcmSettings);
    default:
      throw new Error(`Unknown messaging provider: ${kind}`);
  }
}
