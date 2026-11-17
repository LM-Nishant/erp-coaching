export interface OutboundMessage {
  to: string;
  body: string;
  /** Provider template id where applicable (WhatsApp/SMS DLT). */
  templateId?: string;
  subject?: string;
  data?: Record<string, unknown>;
}

export interface SendResult {
  providerMessageId: string;
  status: 'queued' | 'sent' | 'failed';
}

export type Channel = 'sms' | 'whatsapp' | 'email' | 'push';

export interface MessagingProvider {
  readonly channel: Channel;
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}
