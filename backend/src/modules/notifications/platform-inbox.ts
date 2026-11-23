import type { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import type { InboxItemDto } from '@erp/shared';
import { sha256 } from '../../infrastructure/crypto';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { logger } from '../../infrastructure/logger';
import { MessagingError, getDefaultMessagingProvider } from '../../infrastructure/messaging';
import { outboundSuppressed } from '../../infrastructure/outbound';
import { getContext } from '../../shared/context';
import { NotFound, Unauthorized } from '../../shared/errors';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { parse } from '../../shared/utilities/validation';
import { User } from '../users/user.model';
import { getEvent } from './catalogue';
import { PushToken } from './models';
import { PlatformMessage, PlatformPushToken } from './platform-inbox.models';
import { renderTemplate } from './templates';

export const PLATFORM_PUSH_JOB = 'notifications.platform-push';

/**
 * In-app (and push, when the event uses push) notification for users who belong to no institute, e.g.
 * marketplace-only learners and independent instructors. notify() is institute-scoped; this is the
 * platform-level path, shown by the same bell and inbox (`/notifications/personal/*`). Uses the event's
 * catalogue title/body; push goes through the platform default provider. Call after your transaction commits.
 */
export async function notifyPlatformUsers(input: {
  event: string;
  userIds: number[];
  data?: Record<string, unknown>;
}): Promise<{ messageIds: number[] }> {
  const event = getEvent(input.event);
  const userIds = [...new Set(input.userIds)];
  if (!userIds.length || !event.defaultChannels.includes('in_app')) return { messageIds: [] };
  const users = await User.findAll({ where: { id: userIds, status: 'active' }, attributes: ['id', 'name'] });
  const data = input.data ?? {};
  const rows = users.map((user) => {
    const vars = { ...data, recipient: { name: user.name }, institute: { name: '' } };
    return {
      userId: user.id,
      eventKey: input.event,
      subject: renderTemplate(event.title, vars).slice(0, 255),
      body: renderTemplate(event.body, vars),
      data: Object.keys(data).length ? data : null,
      readAt: null,
    };
  });
  const created = rows.length ? await PlatformMessage.bulkCreate(rows) : [];
  if (event.defaultChannels.includes('push') && !outboundSuppressed()) {
    for (const m of created)
      await enqueueJob(PLATFORM_PUSH_JOB, { messageId: m.id }, { instituteId: null, maxAttempts: 3 });
  }
  return { messageIds: created.map((m) => m.id) };
}

/** Job handler: pushes a personal inbox item to the user's registered devices. */
export async function pushPlatformMessage(payload: { messageId: number }): Promise<void> {
  const msg = await PlatformMessage.findByPk(payload.messageId);
  if (!msg || msg.readAt || outboundSuppressed()) return;
  const provider = await getDefaultMessagingProvider('push');
  // Browser installs register mock tokens that only the console provider accepts.
  const vendorPush = provider.name !== 'console';
  const tokens = await PlatformPushToken.findAll({ where: { userId: msg.userId } });
  for (const t of tokens) {
    if (vendorPush && t.platform === 'web') continue;
    try {
      const result = await provider.send({
        to: t.token,
        subject: msg.subject ?? undefined,
        body: msg.body,
        data: { ...(msg.data ?? {}), messageId: msg.id, eventKey: msg.eventKey, personal: true },
      });
      if (result.status === 'failed') throw new Error(result.error ?? 'Provider reported failure');
    } catch (err) {
      // The device uninstalled the app or the token expired: stop sending to it.
      if (err instanceof MessagingError && err.invalidRecipient) await t.destroy();
      logger.warn(
        { messageId: msg.id, tokenId: t.id, reason: (err as Error).message },
        'Personal push delivery failed',
      );
    }
  }
}

function me(): number {
  const { userId } = getContext();
  if (!userId) throw Unauthorized();
  return userId;
}

function inboxDto(m: PlatformMessage): InboxItemDto {
  return {
    id: m.id,
    eventKey: m.eventKey,
    title: m.subject,
    body: m.body,
    data: m.data,
    readAt: m.readAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

const unreadCount = (userId: number) =>
  PlatformMessage.count({ where: { userId, readAt: { [Op.is]: null } } });

const tokenBody = z.object({ token: z.string().trim().min(8).max(512) });

/**
 * Self-service personal inbox and push devices of the signed-in user (any account, with or without an
 * institute): every query is filtered by the user's own id.
 */
export function platformInboxRoutes(r: Router) {
  r.get('/personal/inbox', async (req, res) => {
    const q = parse(paginationSchema.extend({ unreadOnly: z.coerce.boolean().optional() }), req.query);
    const userId = me();
    const { rows, count } = await PlatformMessage.findAndCountAll({
      where: { userId, ...(q.unreadOnly ? { readAt: { [Op.is]: null } } : {}) },
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json({ ...paginated(rows.map(inboxDto), count, q), unread: await unreadCount(userId) });
  });

  r.get('/personal/inbox/unread-count', async (_req, res) => {
    res.json({ unread: await unreadCount(me()) });
  });

  r.post('/personal/inbox/read-all', async (_req, res) => {
    const [updated] = await PlatformMessage.update(
      { readAt: new Date() },
      { where: { userId: me(), readAt: { [Op.is]: null } } },
    );
    res.json({ updated });
  });

  r.post('/personal/inbox/:id/read', async (req, res) => {
    const { id } = parse(idParam, req.params);
    const m = await PlatformMessage.findOne({ where: { id, userId: me() } });
    if (!m) throw NotFound('Notification');
    if (!m.readAt) await m.update({ readAt: new Date() });
    res.json(inboxDto(m));
  });

  r.post('/personal/push-tokens', async (req, res) => {
    const body = parse(
      tokenBody.extend({
        platform: z.enum(['web', 'android', 'ios']),
        deviceUid: z.string().trim().max(120).nullable().optional(),
      }),
      req.body,
    );
    const userId = me();
    const tokenHash = sha256(body.token);
    // A device token belongs to whoever signed in on that device most recently, so an institute
    // account that used this device no longer gets its pushes.
    await PushToken.destroy({ where: { tokenHash }, tenantBypass: true } as Parameters<
      typeof PushToken.destroy
    >[0]);
    const existing = await PlatformPushToken.findOne({ where: { tokenHash } });
    const values = {
      userId,
      token: body.token,
      platform: body.platform,
      deviceUid: body.deviceUid ?? null,
      lastSeenAt: new Date(),
    };
    const row = existing
      ? await existing.update(values)
      : await PlatformPushToken.create({ ...values, tokenHash });
    res.status(existing ? 200 : 201).json({ id: row.id, platform: row.platform });
  });

  r.delete('/personal/push-tokens', async (req, res) => {
    const { token } = parse(tokenBody, req.body);
    await PlatformPushToken.destroy({ where: { tokenHash: sha256(token), userId: me() } });
    res.status(204).end();
  });
}
