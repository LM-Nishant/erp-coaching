import crypto from 'node:crypto';
import { logger } from '../logger';
import type { Channel, MessagingProvider, OutboundMessage, SendResult } from './types';

export interface SentRecord extends OutboundMessage {
  channel: Channel;
  sentAt: Date;
}

/** In-memory outbox shared by all console providers (handy for dev and tests). */
export const consoleOutbox: SentRecord[] = [];

/** Development provider: logs messages instead of sending them. */
export class ConsoleMessagingProvider implements MessagingProvider {
  readonly name = 'console';
  constructor(readonly channel: Channel) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    consoleOutbox.push({ ...message, channel: this.channel, sentAt: new Date() });
    if (consoleOutbox.length > 500) consoleOutbox.shift();
    logger.info(`[${this.channel.toUpperCase()} → ${message.to}] ${message.subject ? message.subject + ': ' : ''}${message.body}`);
    return { providerMessageId: crypto.randomUUID(), status: 'sent' };
  }
}
