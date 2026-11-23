import { Op, type CreationAttributes } from 'sequelize';
import {
  ANNOUNCEMENT_EVENT,
  type ExternalChannel,
  type MessageStatus,
  type NotificationChannel,
  type RecipientType,
} from '@erp/shared';
import { sha256 } from '../../infrastructure/crypto';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { outboundSuppressed } from '../../infrastructure/outbound';
import { logger } from '../../infrastructure/logger';
import {
  MessagingError,
  isTransientError,
  type DeliveryReceipt,
  type OutboundMessage,
} from '../../infrastructure/messaging';
import { getContext, requireTenantContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { FileObject } from '../files/file.model';
import { signedUrlFor } from '../files/files.service';
import { Institute } from '../institutes/institute.model';
import { User, contactMobile } from '../users/user.model';
import { getEvent } from './catalogue';
import {
  DeliveryAttempt,
  NotificationCampaign,
  NotificationMessage,
  NotificationPreference,
  NotificationRule,
  NotificationTemplate,
  PushToken,
} from './models';
import { resolveProvider, DEFAULT_RETRY, type ResolvedProvider } from './providers.service';
import { hasRecipientResolver, resolveAudience, resolveRecipients, type RecipientSpec } from './recipients';
import { BadRequest } from '../../shared/errors';
import { renderTemplate, templateParams } from './templates';

export const DELIVER_JOB = 'notifications.deliver';
export const CAMPAIGN_JOB = 'notifications.campaign';
/** Upper bound for the exponential retry delay. */
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
/** Vendors download a WhatsApp document or email attachment when the message is sent. */
const ATTACHMENT_URL_TTL_SECONDS = 3600;

export const messageRepo = new TenantRepository(NotificationMessage, { entity: 'Message' });
export const campaignRepo = new TenantRepository(NotificationCampaign, {
  entity: 'Campaign',
  branchScoped: true,
});
const ruleRepo = new TenantRepository(NotificationRule, { entity: 'Rule' });
const templateRepo = new TenantRepository(NotificationTemplate, { entity: 'Template' });
const prefRepo = new TenantRepository(NotificationPreference, { entity: 'Preference' });
const tokenRepo = new TenantRepository(PushToken, { entity: 'Push token' });
const attemptRepo = new TenantRepository(DeliveryAttempt, { entity: 'Delivery attempt' });

export interface NotifyInput {
  /** Catalogue event key, e.g. `fees.receipt`. */
  event: string;
  recipients: RecipientSpec[];
  /**
   * Template variables, e.g. `{ student: { name }, amount, receiptNo }`. Also stored on in-app items.
   * `attachment: { fileId, filename? }` (a stored file of this institute) is sent as a WhatsApp document
   * or email attachment, with a fresh signed link at each attempt.
   */
  data?: Record<string, unknown>;
  /** Branch the event belongs to (delivery history is branch-scoped). Defaults to the active branch. */
  branchId?: number | null;
  /** Override the institute rule's channels for this call. */
  channels?: NotificationChannel[];
}

export interface NotifyResult {
  messageIds: number[];
  queued: number;
  skipped: number;
}

/** Retry delay before attempt `n + 1`: base × 2^(n-1), capped. */
export function retryDelayMs(attemptNo: number, baseDelaySeconds: number): number {
  return Math.min(baseDelaySeconds * 1000 * 2 ** (attemptNo - 1), MAX_RETRY_DELAY_MS);
}

/** Effective trigger rule: institute override, else catalogue defaults. */
export async function effectiveRule(eventKey: string) {
  const def = getEvent(eventKey);
  const rule = await ruleRepo.findOne({ where: { eventKey } });
  return {
    eventKey,
    channels: rule?.channels ?? def.defaultChannels,
    recipientTypes: rule?.recipientTypes ?? def.defaultRecipientTypes,
    isActive: rule?.isActive ?? true,
    isDefault: !rule,
  };
}

/**
 * Platform notification API for every module:
 * resolves the institute's trigger rule → recipients → templates → user preferences/consent, records one
 * message per recipient × channel and enqueues delivery jobs. Call after your transaction commits.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const event = getEvent(input.event);
  const rule = await effectiveRule(input.event);
  if (!rule.isActive) return { messageIds: [], queued: 0, skipped: 0 };
  const channels = input.channels ?? rule.channels;
  if (!channels.length) return { messageIds: [], queued: 0, skipped: 0 };

  const resolved = await resolveRecipients(input.recipients);
  const recipients = new Map<number, RecipientType>();
  for (const [userId, types] of resolved) {
    // Explicitly addressed users always receive it; typed recipients must match the rule.
    const type = rule.recipientTypes.find((t) => types.has(t)) ?? (types.has('user') ? 'user' : undefined);
    if (type) recipients.set(userId, type);
  }

  const templates = await templateRepo.findAll({
    where: { eventKey: input.event, channel: channels, isActive: true },
  });
  return dispatch({
    eventKey: input.event,
    channels,
    recipients,
    data: input.data ?? {},
    branchId: input.branchId,
    mandatory: !!event.mandatory,
    template: (channel) => {
      const t = templates.find((x) => x.channel === channel);
      return {
        subject: t ? t.subject : event.title,
        body: t?.body ?? event.body,
        providerTemplateId: t?.providerTemplateId ?? null,
      };
    },
  });
}

interface DispatchInput {
  eventKey: string;
  channels: NotificationChannel[];
  recipients: Map<number, RecipientType>;
  data: Record<string, unknown>;
  branchId?: number | null;
  campaignId?: number;
  mandatory: boolean;
  template: (channel: NotificationChannel) => {
    subject: string | null;
    body: string;
    providerTemplateId: string | null;
  };
}

/**
 * Whether the user's preferences allow this event on the channel: event-level beats channel-level,
 * except that a STOP reply (source `<channel>-stop`) turns the whole channel off.
 */
function allowedByPreferences(prefs: NotificationPreference[], channel: string, eventKey: string): boolean {
  const channelWide = prefs.find((p) => p.channel === channel && p.eventKey === '*');
  if (channelWide && !channelWide.enabled && channelWide.source === `${channel}-stop`) return false;
  const specific = prefs.find((p) => p.channel === channel && p.eventKey === eventKey);
  if (specific) return specific.enabled;
  return channelWide ? channelWide.enabled : true;
}

/** WhatsApp business messages need the user's explicit opt-in: a channel-wide preference turned on. */
const hasOptedIn = (prefs: NotificationPreference[], channel: string) =>
  prefs.some((p) => p.channel === channel && p.eventKey === '*' && p.enabled);

async function dispatch(input: DispatchInput): Promise<NotifyResult> {
  const ctx = requireTenantContext();
  const userIds = [...input.recipients.keys()];
  if (!userIds.length) return { messageIds: [], queued: 0, skipped: 0 };

  const [users, prefs, tokens, institute] = await Promise.all([
    User.findAll({ where: { id: userIds } }),
    prefRepo.findAll({ where: { userId: userIds, eventKey: [input.eventKey, '*'] } }),
    input.channels.includes('push') ? tokenRepo.findAll({ where: { userId: userIds } }) : Promise.resolve([]),
    Institute.findByPk(ctx.instituteId),
  ]);
  const providers = new Map<NotificationChannel, ResolvedProvider>();
  for (const c of input.channels) {
    if (c !== 'in_app') providers.set(c, await resolveProvider(c));
  }
  const whatsappOptIn = !!providers.get('whatsapp')?.provider.requiresOptIn;
  // Browser installs register mock tokens that only the console provider accepts.
  const vendorPush = (providers.get('push')?.provider.name ?? 'console') !== 'console';

  const branchId = input.branchId !== undefined ? input.branchId : (ctx.activeBranchId ?? null);
  const now = new Date();
  const rows: CreationAttributes<NotificationMessage>[] = [];
  for (const user of users) {
    if (user.status !== 'active') continue;
    const userPrefs = prefs.filter((p) => p.userId === user.id);
    const vars = {
      ...input.data,
      recipient: { name: user.name },
      institute: { name: institute?.name ?? '' },
    };
    for (const channel of input.channels) {
      const tpl = input.template(channel);
      const base = {
        instituteId: ctx.instituteId,
        branchId,
        eventKey: input.eventKey,
        channel,
        userId: user.id,
        recipientType: input.recipients.get(user.id) ?? null,
        subject: tpl.subject ? renderTemplate(tpl.subject, vars).slice(0, 255) : null,
        body: renderTemplate(tpl.body, vars),
        data: Object.keys(input.data).length ? input.data : null,
        provider: null,
        providerTemplateId: tpl.providerTemplateId,
        templateParams: tpl.providerTemplateId ? templateParams(tpl.body, vars) : null,
        providerMessageId: null,
        maxAttempts: providers.get(channel)?.retryMaxAttempts ?? DEFAULT_RETRY.maxAttempts,
        nextAttemptAt: null,
        lastError: null as string | null,
        campaignId: input.campaignId ?? null,
        sentAt: null,
        deliveredAt: null,
        readAt: null,
      };
      const skip = (reason: string, address: string | null = null) =>
        rows.push({ ...base, recipientAddress: address, status: 'skipped', lastError: reason });

      if (!input.mandatory && !allowedByPreferences(userPrefs, channel, input.eventKey)) {
        skip('Recipient opted out');
        continue;
      }
      if (channel === 'whatsapp' && whatsappOptIn && !hasOptedIn(userPrefs, channel)) {
        skip('No WhatsApp opt-in');
        continue;
      }
      if (channel === 'in_app') {
        rows.push({ ...base, recipientAddress: null, status: 'delivered', sentAt: now, deliveredAt: now });
        continue;
      }
      const suppressed = outboundSuppressed();
      if (suppressed) {
        skip(suppressed);
        continue;
      }
      const addresses =
        channel === 'push'
          ? tokens
              .filter((t) => t.userId === user.id && !(vendorPush && t.platform === 'web'))
              .map((t) => t.token)
          : [channel === 'email' ? user.email : contactMobile(user)].filter((a): a is string => !!a);
      if (!addresses.length) {
        skip(channel === 'push' ? 'No registered device' : `No ${channel === 'email' ? 'email' : 'mobile'}`);
        continue;
      }
      for (const address of addresses) rows.push({ ...base, recipientAddress: address, status: 'queued' });
    }
  }

  // Bulk insert bypasses TenantRepository; instituteId is set explicitly from context above.
  const created = rows.length ? await NotificationMessage.bulkCreate(rows) : [];
  let queued = 0;
  for (const m of created) {
    if (m.status !== 'queued') continue;
    queued++;
    await enqueueJob(DELIVER_JOB, { messageId: m.id }, { maxAttempts: 1 });
  }
  return {
    messageIds: created.map((m) => m.id),
    queued,
    skipped: created.filter((m) => m.status === 'skipped').length,
  };
}

/** Job handler: one delivery attempt; schedules the next attempt with exponential backoff. */
export async function deliverMessage(payload: { messageId: number }): Promise<void> {
  const msg = await messageRepo.findOne({ where: { id: payload.messageId } });
  if (!msg || msg.status !== 'queued' || msg.channel === 'in_app') return;
  const suppressed = outboundSuppressed();
  if (suppressed) {
    await msg.update({ status: 'skipped', lastError: suppressed, nextAttemptAt: null });
    return;
  }
  const { provider, retryBaseDelaySeconds } = await resolveProvider(msg.channel as ExternalChannel);
  const attemptNo = msg.attempts + 1;
  const started = Date.now();
  try {
    const result = await provider.send({
      to: msg.recipientAddress ?? '',
      body: msg.body,
      subject: msg.subject ?? undefined,
      templateId: msg.providerTemplateId ?? undefined,
      variables: msg.templateParams ?? undefined,
      document: await attachmentOf(msg),
      data: { ...(msg.data ?? {}), messageId: msg.id, eventKey: msg.eventKey },
    });
    if (result.status === 'failed') throw new Error(result.error ?? 'Provider reported failure');
    const status = result.status === 'delivered' ? 'delivered' : 'sent';
    await attemptRepo.create({
      messageId: msg.id,
      attemptNo,
      status,
      provider: provider.name,
      providerMessageId: result.providerMessageId,
      error: null,
      durationMs: Date.now() - started,
    });
    await msg.update({
      status,
      attempts: attemptNo,
      provider: provider.name,
      providerMessageId: result.providerMessageId,
      sentAt: new Date(),
      deliveredAt: status === 'delivered' ? new Date() : null,
      nextAttemptAt: null,
      lastError: null,
    });
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 4000);
    await attemptRepo.create({
      messageId: msg.id,
      attemptNo,
      status: 'failed',
      provider: provider.name,
      providerMessageId: null,
      error,
      durationMs: Date.now() - started,
    });
    // Only transient errors (timeouts, rate limits, vendor outages) are retried; a rejected
    // recipient, template or credential fails the same way on every attempt.
    const retry = isTransientError(err) && attemptNo < msg.maxAttempts;
    const vendorDelay = err instanceof MessagingError ? (err.retryAfterMs ?? 0) : 0;
    const nextAttemptAt = retry
      ? new Date(
          Date.now() +
            Math.min(
              Math.max(retryDelayMs(attemptNo, retryBaseDelaySeconds), vendorDelay),
              MAX_RETRY_DELAY_MS,
            ),
        )
      : null;
    await msg.update({
      status: retry ? 'queued' : 'failed',
      attempts: attemptNo,
      provider: provider.name,
      lastError: error,
      nextAttemptAt,
    });
    if (nextAttemptAt)
      await enqueueJob(DELIVER_JOB, { messageId: msg.id }, { runAt: nextAttemptAt, maxAttempts: 1 });
    if (
      msg.channel === 'push' &&
      err instanceof MessagingError &&
      err.invalidRecipient &&
      msg.recipientAddress
    ) {
      // The device uninstalled the app or the token expired: stop sending to it.
      await PushToken.destroy({
        where: { instituteId: msg.instituteId, tokenHash: sha256(msg.recipientAddress) },
      });
    }
    logger.warn(
      { messageId: msg.id, attemptNo, retry, code: err instanceof MessagingError ? err.code : undefined },
      `Notification delivery failed: ${error}`,
    );
  }
}

/** `data.attachment = { fileId, filename }`: a fresh link to the stored file for the vendor to download. */
async function attachmentOf(msg: NotificationMessage): Promise<OutboundMessage['document']> {
  const attachment = (msg.data as { attachment?: { fileId?: unknown; filename?: unknown } } | null)
    ?.attachment;
  if (!attachment || typeof attachment.fileId !== 'number') return undefined;
  const file = await FileObject.findOne({ where: { instituteId: msg.instituteId, id: attachment.fileId } });
  if (!file) return undefined;
  const filename =
    typeof attachment.filename === 'string' && attachment.filename ? attachment.filename : file.originalName;
  return { url: signedUrlFor(file, ATTACHMENT_URL_TTL_SECONDS).url, filename };
}

/** Manually re-queues a failed message for another round of attempts. */
export async function retryMessage(id: number) {
  const msg = await messageRepo.findById(id);
  const { retryMaxAttempts } = await resolveProvider(msg.channel as ExternalChannel);
  await msg.update({ status: 'queued', maxAttempts: msg.attempts + retryMaxAttempts, nextAttemptAt: null });
  await enqueueJob(DELIVER_JOB, { messageId: msg.id }, { maxAttempts: 1 });
  return msg;
}

/**
 * Whether a vendor status moves the message forward. Receipts arrive late, twice or out of order:
 * delivered beats everything, failed beats queued/sent, and nothing moves a message backwards.
 */
function receiptApplies(current: MessageStatus, next: DeliveryReceipt['status']): boolean {
  if (current === next || current === 'skipped' || current === 'delivered') return false;
  if (next === 'delivered') return true;
  if (next === 'failed') return current === 'queued' || current === 'sent';
  return current === 'queued';
}

/**
 * Applies vendor delivery receipts (from the signed webhooks) to the messages sent with that vendor.
 * `instituteId = null` (platform provider) matches messages of every institute by the vendor's message
 * id. Idempotent; returns how many messages matched.
 */
export async function applyDeliveryReceipts(input: {
  provider: string;
  instituteId: number | null;
  receipts: DeliveryReceipt[];
}): Promise<{ matched: number; updated: number }> {
  let matched = 0;
  let updated = 0;
  for (const receipt of input.receipts) {
    const ids = [...new Set(receipt.ids.filter((id) => id && id.length <= 190))].slice(0, 10);
    if (!ids.length) continue;
    const messages = await NotificationMessage.findAll({
      where: {
        provider: input.provider,
        providerMessageId: ids,
        ...(input.instituteId !== null ? { instituteId: input.instituteId } : {}),
      },
      limit: 20,
      tenantBypass: true,
    } as Parameters<typeof NotificationMessage.findAll>[0]);
    for (const msg of messages) {
      matched++;
      if (!receiptApplies(msg.status, receipt.status)) continue;
      const error = receipt.status === 'failed' ? (receipt.error ?? 'Delivery failed').slice(0, 4000) : null;
      await msg.update(
        receipt.status === 'delivered'
          ? { status: 'delivered', deliveredAt: new Date(), nextAttemptAt: null }
          : receipt.status === 'failed'
            ? { status: 'failed', lastError: error, nextAttemptAt: null }
            : { status: 'sent' },
      );
      if (receipt.status !== 'sent') {
        const attempt = await DeliveryAttempt.findOne({
          where: {
            instituteId: msg.instituteId,
            messageId: msg.id,
            providerMessageId: msg.providerMessageId,
          },
          order: [['id', 'DESC']],
        });
        if (attempt && attempt.status !== 'delivered')
          await attempt.update({ status: receipt.status, error });
      }
      updated++;
    }
  }
  return { matched, updated };
}

/** Applies one delivery receipt to the message with that vendor id (any institute). */
export async function recordDeliveryReceipt(input: {
  provider: string;
  providerMessageId: string;
  status: Extract<MessageStatus, 'delivered' | 'failed'>;
  error?: string;
}): Promise<boolean> {
  const { matched } = await applyDeliveryReceipts({
    provider: input.provider,
    instituteId: null,
    receipts: [{ ids: [input.providerMessageId], status: input.status, error: input.error }],
  });
  return matched > 0;
}

/** Job handler: expands a bulk/scheduled campaign into messages. */
export async function runCampaign(payload: { campaignId: number }): Promise<void> {
  const campaign = await NotificationCampaign.findOne({
    where: { id: payload.campaignId, instituteId: requireTenantContext().instituteId },
  });
  if (!campaign || campaign.status !== 'scheduled') return;
  await campaign.update({ status: 'processing' });
  try {
    const recipients = await resolveAudience(campaign.audience);
    const result = await dispatch({
      eventKey: ANNOUNCEMENT_EVENT,
      channels: campaign.channels,
      recipients,
      data: { title: campaign.title },
      branchId: campaign.branchId,
      campaignId: campaign.id,
      mandatory: false,
      template: () => ({
        subject: campaign.subject ?? campaign.title,
        body: campaign.body,
        providerTemplateId: null,
      }),
    });
    await campaign.update({
      status: 'sent',
      recipientCount: recipients.size,
      messageCount: result.messageIds.length,
    });
  } catch (err) {
    await campaign.update({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Creates a bulk message, sent now or at `scheduledAt`. */
export async function createCampaign(input: {
  title: string;
  channels: NotificationChannel[];
  subject?: string | null;
  body: string;
  audience: NotificationCampaign['audience'];
  scheduledAt?: Date | null;
  branchId: number | null;
}) {
  if (input.audience.batchIds?.length && !hasRecipientResolver('batchMembers'))
    throw BadRequest('Batch audiences are not available until the batches module is installed');
  const campaign = await campaignRepo.create({
    title: input.title,
    channels: input.channels,
    subject: input.subject ?? null,
    body: input.body,
    audience: input.audience,
    scheduledAt: input.scheduledAt ?? null,
    status: 'scheduled',
    branchId: input.branchId,
    error: null,
    createdBy: getContext().userId ?? null,
  });
  await enqueueJob(
    CAMPAIGN_JOB,
    { campaignId: campaign.id },
    { runAt: input.scheduledAt ?? new Date(), maxAttempts: 1 },
  );
  return campaign;
}

/** Unread in-app count for the current user. */
export async function unreadCount(userId: number): Promise<number> {
  return messageRepo.count({ userId, channel: 'in_app', status: 'delivered', readAt: { [Op.is]: null } });
}
