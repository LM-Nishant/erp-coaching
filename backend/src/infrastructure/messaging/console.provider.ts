import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
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
  constructor(
    readonly channel: Channel,
    /** Mock failures: recipients containing this text fail (used to exercise retries). */
    private readonly opts: { failPattern?: string } = {},
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.opts.failPattern && message.to.includes(this.opts.failPattern)) {
      throw new Error(`Mock ${this.channel} delivery failure for ${message.to}`);
    }
    const record: SentRecord = { ...message, channel: this.channel, sentAt: new Date() };
    consoleOutbox.push(record);
    if (consoleOutbox.length > 500) consoleOutbox.shift();
    if (config.devOutboxFile) appendToOutboxFile(config.devOutboxFile, record);
    logger.info(
      `[${this.channel.toUpperCase()} → ${message.to}] ${message.subject ? message.subject + ': ' : ''}${message.body}`,
    );
    return { providerMessageId: crypto.randomUUID(), status: 'sent' };
  }
}

/** DEV_OUTBOX_FILE (never in production): lets browser E2E tests read OTPs and notifications. */
function appendToOutboxFile(file: string, record: SentRecord) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch (err) {
    logger.warn({ err, file }, 'could not append to DEV_OUTBOX_FILE');
  }
}
