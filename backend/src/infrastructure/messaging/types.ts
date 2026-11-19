export interface TemplateVariable {
  /** Placeholder name in the institute template (`student.name`). */
  name: string;
  value: string;
}

export interface OutboundMessage {
  to: string;
  /** Rendered text. Vendors with approved templates render their own copy from `variables`. */
  body: string;
  /**
   * Vendor template: MSG91 flow template id or 19-digit DLT template id, WhatsApp template
   * `name` or `name:language`, Twilio Content SID (`HX…`).
   */
  templateId?: string;
  /** Values of the template placeholders in order of appearance (positional vendor variables). */
  variables?: TemplateVariable[];
  /** Platform messages whose vendor template comes from the provider settings (login OTP). */
  templateKey?: 'otp';
  /** Document sent with the message: WhatsApp document header or media, email attachment. */
  document?: { url: string; filename: string };
  subject?: string;
  data?: Record<string, unknown>;
}

export interface SendResult {
  providerMessageId: string;
  /** `delivered` when the provider confirms delivery synchronously (rare); otherwise `sent`/`queued`. */
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  /** Provider error description when status is `failed`. */
  error?: string;
}

export type Channel = 'sms' | 'whatsapp' | 'email' | 'push';

/** Decrypted provider settings (`PROVIDER_FIELDS` keys). */
export type ProviderSettings = Record<string, string>;

export interface ProviderOptions {
  /** Delivery-status callback URL for vendors that take one per message (Twilio). */
  webhookUrl?: string;
}

export interface MessagingProvider {
  readonly channel: Channel;
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Checks the credentials with the vendor without messaging anyone; resolves with a short summary. */
  verify?(): Promise<string>;
  /** WhatsApp vendors: business-initiated messages need the recipient's explicit opt-in. */
  readonly requiresOptIn?: boolean;
}
