/**
 * Reads the API's DEV_OUTBOX_FILE: one JSON line per SMS/WhatsApp/email/push message that the
 * console messaging provider "sent" (login OTPs, parent alerts, …).
 */
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { OUTBOX_FILE } from './env';

export type Channel = 'sms' | 'whatsapp' | 'email' | 'push';

export interface OutboxMessage {
  to: string;
  body: string;
  subject?: string;
  data?: Record<string, unknown>;
  channel: Channel;
  sentAt: string;
}

/** Byte offset of the end of the outbox: pass it to the readers to ignore older messages. */
export function outboxMark(): number {
  try {
    return fs.statSync(OUTBOX_FILE).size;
  } catch {
    return 0;
  }
}

/** Messages appended after `since` (a mark). Incomplete trailing lines are skipped. */
export function outboxMessages(since = 0): OutboxMessage[] {
  let text: string;
  try {
    const buffer = fs.readFileSync(OUTBOX_FILE);
    text = buffer.subarray(Math.min(since, buffer.length)).toString('utf8');
  } catch {
    return [];
  }
  const messages: OutboxMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as OutboxMessage);
    } catch {
      // A line being written right now (or cut by the mark): it is picked up by the next poll.
    }
  }
  return messages;
}

const HINT =
  `Nothing matched in ${OUTBOX_FILE}. If you started the API yourself, start it with ` +
  '`npm run serve:api -w @erp/e2e` so it writes this outbox file.';

/** Polls the outbox until a message matching `predicate` arrives after `since`; returns the newest. */
export async function waitForMessage(
  predicate: (message: OutboxMessage) => boolean,
  options: { since?: number; timeout?: number; description?: string } = {},
): Promise<OutboxMessage> {
  let found: OutboxMessage | undefined;
  await expect
    .poll(
      () => {
        found = outboxMessages(options.since).filter(predicate).at(-1);
        return found !== undefined;
      },
      {
        message: `${options.description ?? 'Outbox message'} not sent. ${HINT}`,
        timeout: options.timeout ?? 20_000,
      },
    )
    .toBe(true);
  return found!;
}

/** The newest login OTP sent to `mobile` after `since`. */
export async function waitForOtp(mobile: string, since = 0): Promise<string> {
  const message = await waitForMessage((m) => m.to === mobile && typeof m.data?.otp === 'string', {
    since,
    description: `OTP for ${mobile}`,
  });
  return message.data!.otp as string;
}
