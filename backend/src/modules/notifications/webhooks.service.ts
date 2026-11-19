import crypto from 'node:crypto';
import { logger } from '../../infrastructure/logger';
import {
  consentKeyword,
  messagingWebhookUrl,
  parseMsg91,
  parseTwilio,
  parseWhatsAppCloud,
  resolvePlatformWebhook,
  storedMobileForms,
  verifyMetaSignature,
  verifyTwilioSignature,
  whatsappVerifyToken,
  type InboundText,
  type ProviderSettings,
  type WebhookEvents,
} from '../../infrastructure/messaging';
import { audit } from '../../shared/audit/audit.service';
import { runWithContext } from '../../shared/context';
import { AppError, NotFound } from '../../shared/errors';
import { UserRole } from '../permissions/models';
import { User } from '../users/user.model';
import { NotificationPreference, NotificationProvider } from './models';
import { applyDeliveryReceipts } from './notify.service';
import { providerSettings } from './providers.service';

export type MessagingWebhookVendor = 'msg91' | 'twilio' | 'whatsapp-cloud';

interface WebhookOwner {
  /** null = the platform (super admin) provider, used by every institute without its own. */
  instituteId: number | null;
  settings: ProviderSettings;
}

type Headers = Record<string, string | string[] | undefined>;
const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const invalidSignature = () => new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');

/** The institute provider (or platform provider) that owns the secret key in the webhook URL. */
async function findOwner(vendor: MessagingWebhookVendor, webhookKey: string): Promise<WebhookOwner> {
  // Platform lookup: the webhook is unauthenticated, the key identifies the provider row.
  const row = await NotificationProvider.findOne({
    where: { provider: vendor, webhookKey },
    tenantBypass: true,
  } as Parameters<typeof NotificationProvider.findOne>[0]);
  if (row) return { instituteId: row.instituteId, settings: providerSettings(row) };
  const platform = await resolvePlatformWebhook(vendor, webhookKey);
  if (platform && platform.kind === vendor) return { instituteId: null, settings: platform.settings };
  throw NotFound('Webhook');
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Meta's subscription handshake: echo `hub.challenge` when the verify token matches. */
export async function whatsappHandshake(webhookKey: string, query: Record<string, unknown>): Promise<string> {
  await findOwner('whatsapp-cloud', webhookKey);
  const token = typeof query['hub.verify_token'] === 'string' ? query['hub.verify_token'] : '';
  const challenge = typeof query['hub.challenge'] === 'string' ? query['hub.challenge'] : '';
  if (query['hub.mode'] !== 'subscribe' || !safeEqual(token, whatsappVerifyToken(webhookKey))) {
    throw new AppError(403, 'INVALID_VERIFY_TOKEN', 'Verify token does not match');
  }
  return challenge.slice(0, 200);
}

function parseForm(raw: Buffer): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(raw.toString('utf8'))) {
    const prev = out[key];
    out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}

function parseBody(raw: Buffer): unknown {
  const textBody = raw.toString('utf8').trim();
  if (!textBody) return {};
  if (textBody.startsWith('{') || textBody.startsWith('[')) {
    try {
      return JSON.parse(textBody);
    } catch {
      throw new AppError(400, 'INVALID_WEBHOOK', 'Malformed JSON');
    }
  }
  return parseForm(raw);
}

/**
 * Verifies and applies a vendor webhook: delivery receipts update the messages sent through that
 * provider (forward only), STOP/START replies update the sender's channel consent. Idempotent, so
 * vendor redeliveries are harmless.
 */
export async function processMessagingWebhook(input: {
  vendor: MessagingWebhookVendor;
  webhookKey: string;
  rawBody: Buffer;
  headers: Headers;
  /** Query string of the request (`?a=b` or ''), part of the URL Twilio signs. */
  search: string;
}): Promise<{ receipts: number; updated: number; consent: number }> {
  const owner = await findOwner(input.vendor, input.webhookKey);
  let events: WebhookEvents;
  switch (input.vendor) {
    case 'whatsapp-cloud': {
      if (
        !verifyMetaSignature(
          owner.settings.appSecret ?? '',
          input.rawBody,
          header(input.headers, 'x-hub-signature-256'),
        )
      )
        throw invalidSignature();
      events = parseWhatsAppCloud(parseBody(input.rawBody));
      break;
    }
    case 'twilio': {
      const params = parseForm(input.rawBody);
      const url = messagingWebhookUrl('twilio', input.webhookKey) + input.search;
      if (
        !verifyTwilioSignature(
          owner.settings.authToken ?? '',
          url,
          params,
          header(input.headers, 'x-twilio-signature'),
        )
      )
        throw invalidSignature();
      events = parseTwilio(params);
      break;
    }
    case 'msg91':
      // MSG91 does not sign its callbacks: the unguessable key in the URL authenticates them.
      events = parseMsg91(parseBody(input.rawBody));
      break;
  }
  const { matched, updated } = await runWithContext(
    { system: true, instituteId: owner.instituteId ?? undefined, allowedBranchIds: null },
    () =>
      applyDeliveryReceipts({
        provider: input.vendor,
        instituteId: owner.instituteId,
        receipts: events.receipts,
      }),
  );
  let consent = 0;
  for (const inbound of events.inbound.slice(0, 20))
    consent += await applyConsentKeyword(owner.instituteId, inbound);
  return { receipts: matched, updated, consent };
}

/**
 * STOP/START replies: turns the sender's channel off/on in each institute that messages them through
 * this provider. An institute provider covers that institute; the platform provider covers the
 * sender's institutes that have no active provider of their own for the channel.
 */
async function applyConsentKeyword(instituteId: number | null, inbound: InboundText): Promise<number> {
  const keyword = consentKeyword(inbound.text);
  if (!keyword || !inbound.from) return 0;
  const users = await User.findAll({
    where: { mobile: storedMobileForms(inbound.from) },
    attributes: ['id'],
  });
  if (!users.length) return 0;
  const roles = await UserRole.findAll({
    where: { userId: users.map((u) => u.id), ...(instituteId !== null ? { instituteId } : {}) },
    attributes: ['userId', 'instituteId'],
    tenantBypass: true,
  } as Parameters<typeof UserRole.findAll>[0]);
  let targets = [...new Map(roles.map((r) => [`${r.userId}:${r.instituteId}`, r])).values()];
  if (instituteId === null && targets.length) {
    const own = await NotificationProvider.findAll({
      where: {
        instituteId: [...new Set(targets.map((t) => t.instituteId))],
        channel: inbound.channel,
        isActive: true,
      },
      attributes: ['instituteId'],
      tenantBypass: true,
    } as Parameters<typeof NotificationProvider.findAll>[0]);
    const covered = new Set(own.map((p) => p.instituteId));
    targets = targets.filter((t) => !covered.has(t.instituteId));
  }
  const enabled = keyword === 'opt-in';
  const source = `${inbound.channel}-${enabled ? 'start' : 'stop'}`;
  let changed = 0;
  for (const target of targets.slice(0, 50)) {
    await runWithContext(
      { system: true, instituteId: target.instituteId, allowedBranchIds: null },
      async () => {
        const where = {
          instituteId: target.instituteId,
          userId: target.userId,
          channel: inbound.channel,
          eventKey: '*',
        };
        const pref = await NotificationPreference.findOne({ where });
        if (pref?.enabled === enabled && pref.source === source) return;
        if (pref) await pref.update({ enabled, source, ip: null });
        else await NotificationPreference.create({ ...where, enabled, source, ip: null });
        await audit({
          action: 'notifications.consent_keyword',
          instituteId: target.instituteId,
          entityType: 'user',
          entityId: target.userId,
          metadata: { channel: inbound.channel, keyword },
        });
        changed++;
      },
    );
  }
  if (changed)
    logger.info({ channel: inbound.channel, keyword, changed }, 'Messaging consent updated from a reply');
  return changed;
}
