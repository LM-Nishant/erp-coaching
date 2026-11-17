import type { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { NOTIFICATION_CHANNELS, type InboxItemDto, type NotificationPreferenceDto } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { requirePermission } from '../../shared/middleware/authorize';
import { getContext, requireTenantContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { sha256 } from '../../infrastructure/crypto';
import { findEvent } from './catalogue';
import { NotificationMessage, NotificationPreference, PushToken } from './models';
import { messageRepo, unreadCount } from './notify.service';

const prefRepo = new TenantRepository(NotificationPreference, { entity: 'Preference' });
const tokenRepo = new TenantRepository(PushToken, { entity: 'Push token' });

const me = () => {
  const { userId } = requireTenantContext();
  return userId!;
};

const inboxWhere = (extra: Record<string | symbol, unknown> = {}) => ({
  userId: me(),
  channel: 'in_app',
  status: 'delivered',
  ...extra,
});

function inboxDto(m: NotificationMessage): InboxItemDto {
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

const prefsBody = z.object({
  preferences: z
    .array(
      z.object({
        channel: z.enum(NOTIFICATION_CHANNELS),
        eventKey: z
          .string()
          .max(80)
          .nullable()
          .refine((k) => k === null || !!findEvent(k), 'Unknown event'),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(200),
});

/** Self-service: the current user's inbox, preferences/consent and push devices. */
export function inboxRoutes(r: Router) {
  const view = requirePermission('notification-inbox', 'view');
  const edit = requirePermission('notification-inbox', 'edit');

  r.get('/inbox', view, async (req, res) => {
    const q = parse(paginationSchema.extend({ unreadOnly: z.coerce.boolean().optional() }), req.query);
    const { rows, count } = await messageRepo.findAndCountAll({
      where: inboxWhere(q.unreadOnly ? { readAt: { [Op.is]: null } } : {}),
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json({ ...paginated(rows.map(inboxDto), count, q), unread: await unreadCount(me()) });
  });

  r.get('/inbox/unread-count', view, async (_req, res) => {
    res.json({ unread: await unreadCount(me()) });
  });

  r.post('/inbox/read-all', view, async (_req, res) => {
    const { instituteId } = requireTenantContext();
    const [updated] = await NotificationMessage.update(
      { readAt: new Date() },
      { where: { instituteId, ...inboxWhere({ readAt: { [Op.is]: null } }) } },
    );
    res.json({ updated });
  });

  r.post('/inbox/:id/read', view, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const m = await messageRepo.findOne({ where: inboxWhere({ id }) });
    if (!m) throw NotFound('Notification');
    if (!m.readAt) await m.update({ readAt: new Date() });
    res.json(inboxDto(m));
  });

  r.get('/preferences', view, async (_req, res) => {
    const rows = await prefRepo.findAll({ where: { userId: me() } });
    const items: NotificationPreferenceDto[] = rows.map((p) => ({
      channel: p.channel,
      eventKey: p.eventKey === '*' ? null : p.eventKey,
      enabled: p.enabled,
    }));
    res.json(items);
  });

  r.put('/preferences', edit, async (req, res) => {
    const body = parse(prefsBody, req.body);
    const userId = me();
    const { ip } = getContext();
    for (const p of body.preferences) {
      const eventKey = p.eventKey ?? '*';
      const existing = await prefRepo.findOne({ where: { userId, channel: p.channel, eventKey } });
      if (existing) await existing.update({ enabled: p.enabled, source: 'user', ip: ip ?? null });
      else
        await prefRepo.create({
          userId,
          channel: p.channel,
          eventKey,
          enabled: p.enabled,
          source: 'user',
          ip: ip ?? null,
        });
    }
    await audit({
      action: 'notifications.preferences_updated',
      entityType: 'user',
      entityId: userId,
      metadata: { preferences: body.preferences },
    });
    const rows = await prefRepo.findAll({ where: { userId } });
    res.json(
      rows.map((p) => ({
        channel: p.channel,
        eventKey: p.eventKey === '*' ? null : p.eventKey,
        enabled: p.enabled,
      })),
    );
  });

  r.post('/push-tokens', edit, async (req, res) => {
    const body = parse(
      z.object({
        token: z.string().trim().min(8).max(512),
        platform: z.enum(['web', 'android', 'ios']),
        deviceUid: z.string().trim().max(120).nullable().optional(),
      }),
      req.body,
    );
    const userId = me();
    const tokenHash = sha256(body.token);
    const existing = await tokenRepo.findOne({ where: { tokenHash } });
    // A device token belongs to whoever signed in on that device most recently.
    const values = {
      userId,
      token: body.token,
      platform: body.platform,
      deviceUid: body.deviceUid ?? null,
      lastSeenAt: new Date(),
    };
    const row = existing ? await existing.update(values) : await tokenRepo.create({ ...values, tokenHash });
    res.status(existing ? 200 : 201).json({ id: row.id, platform: row.platform });
  });

  r.delete('/push-tokens', edit, async (req, res) => {
    const { token } = parse(z.object({ token: z.string().trim().min(8).max(512) }), req.body);
    const row = await tokenRepo.findOne({ where: { tokenHash: sha256(token), userId: me() } });
    if (row) await row.destroy();
    res.status(204).end();
  });
}
