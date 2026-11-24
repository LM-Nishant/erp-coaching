import express, { Router, type Request, type Response } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import {
  BATCH_RECIPIENTS,
  MESSAGE_STATUSES,
  MESSAGING_PROVIDER_KINDS,
  NOTIFICATION_CHANNELS,
  RECIPIENT_TYPES,
  type CampaignDto,
  type NotificationMessageDto,
  type NotificationTemplateDto,
} from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { webhookRateLimit } from '../../shared/middleware/security';
import { requirePermission } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest, Conflict, Forbidden } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import { getEvent, listEvents } from './catalogue';
import { DeliveryAttempt, NotificationMessage, NotificationRule, NotificationTemplate } from './models';
import {
  listProviders,
  providerRepo,
  resolveProvider,
  saveProvider,
  toProviderDto,
  verifyProvider,
} from './providers.service';
import { campaignRepo, createCampaign, effectiveRule, retryMessage } from './notify.service';
import { resolveAudience } from './recipients';
import { renderTemplate, sampleVars } from './templates';
import { inboxRoutes } from './inbox.routes';
import { platformInboxRoutes } from './platform-inbox';
import { processMessagingWebhook, whatsappHandshake, type MessagingWebhookVendor } from './webhooks.service';

export const templateRepo = new TenantRepository(NotificationTemplate, { entity: 'Template' });
const ruleRepo = new TenantRepository(NotificationRule, { entity: 'Rule' });
/** Delivery history is branch-scoped: branch admins see their branches' messages only. */
const historyRepo = new TenantRepository(NotificationMessage, { entity: 'Message', branchScoped: true });
const attemptRepo = new TenantRepository(DeliveryAttempt, { entity: 'Delivery attempt' });

const channelEnum = z.enum(NOTIFICATION_CHANNELS);
const externalChannelEnum = z.enum(['push', 'sms', 'whatsapp', 'email']);
const providerKindEnum = z.enum(
  Object.keys(MESSAGING_PROVIDER_KINDS) as [keyof typeof MESSAGING_PROVIDER_KINDS],
);
const eventKey = z
  .string()
  .max(80)
  .refine((k) => {
    try {
      getEvent(k);
      return true;
    } catch {
      return false;
    }
  }, 'Unknown event');

const providerBody = z.object({
  provider: providerKindEnum,
  isActive: z.boolean().default(true),
  settings: z.record(z.string(), z.string().max(4000)).default({}),
  retryMaxAttempts: z.number().int().min(1).max(10).optional(),
  retryBaseDelaySeconds: z.number().int().min(5).max(3600).optional(),
});

const templateBody = z.object({
  eventKey,
  channel: channelEnum,
  subject: z.string().trim().max(255).nullable().optional(),
  body: z.string().trim().min(1).max(4000),
  providerTemplateId: z.string().trim().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
});

const ruleBody = z.object({
  channels: z.array(channelEnum).max(5),
  recipientTypes: z.array(z.enum(RECIPIENT_TYPES)).min(1),
  isActive: z.boolean().default(true),
});

const campaignAudience = z
  .object({
    branchIds: z.array(z.number().int().positive()).max(100).optional(),
    roles: z.array(z.string().max(60)).max(20).optional(),
    batchIds: z.array(z.number().int().positive()).max(200).optional(),
    batchRecipients: z.array(z.enum(BATCH_RECIPIENTS)).min(1).max(3).optional(),
    userIds: z.array(z.number().int().positive()).max(5000).optional(),
  })
  .refine(
    (a) => !!(a.branchIds?.length || a.roles?.length || a.batchIds?.length || a.userIds?.length),
    'Choose at least one audience filter',
  );

const campaignBody = z.object({
  title: z.string().trim().min(2).max(150),
  channels: z.array(channelEnum).min(1).max(5),
  subject: z.string().trim().max(255).nullable().optional(),
  body: z.string().trim().min(1).max(4000),
  audience: campaignAudience,
  scheduledAt: z.coerce.date().nullable().optional(),
});

const historyQuery = paginationSchema.extend({
  status: z.enum(MESSAGE_STATUSES).optional(),
  channel: channelEnum.optional(),
  eventKey: z.string().max(80).optional(),
  userId: z.coerce.number().int().positive().optional(),
  campaignId: z.coerce.number().int().positive().optional(),
});

const unique = <T>(xs: T[]) => [...new Set(xs)];

function templateDto(t: NotificationTemplate): NotificationTemplateDto {
  return {
    id: t.id,
    eventKey: t.eventKey,
    channel: t.channel,
    subject: t.subject,
    body: t.body,
    providerTemplateId: t.providerTemplateId,
    isActive: t.isActive,
  };
}

function messageDto(m: NotificationMessage, names: Map<number, string>): NotificationMessageDto {
  return {
    id: m.id,
    eventKey: m.eventKey,
    channel: m.channel,
    userId: m.userId,
    recipientName: m.userId ? (names.get(m.userId) ?? null) : null,
    recipientAddress: m.recipientAddress,
    subject: m.subject,
    body: m.body,
    status: m.status,
    provider: m.provider,
    attempts: m.attempts,
    maxAttempts: m.maxAttempts,
    lastError: m.lastError,
    campaignId: m.campaignId,
    nextAttemptAt: m.nextAttemptAt?.toISOString() ?? null,
    sentAt: m.sentAt?.toISOString() ?? null,
    deliveredAt: m.deliveredAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

function campaignDto(c: Awaited<ReturnType<typeof campaignRepo.findById>>): CampaignDto {
  return {
    id: c.id,
    title: c.title,
    channels: c.channels,
    subject: c.subject,
    body: c.body,
    audience: c.audience,
    scheduledAt: c.scheduledAt?.toISOString() ?? null,
    status: c.status,
    recipientCount: c.recipientCount,
    messageCount: c.messageCount,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
  };
}

async function userNames(ids: (number | null)[]) {
  const list = unique(ids.filter((i): i is number => !!i));
  if (!list.length) return new Map<number, string>();
  const users = await User.findAll({ where: { id: list }, attributes: ['id', 'name'] });
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Admin side: providers, templates, rules, compose/bulk/scheduled, delivery history. */
export function notificationAdminRoutes(r: Router) {
  const can = (action: Parameters<typeof requirePermission>[1]) => requirePermission('notifications', action);

  r.get('/events', can('view'), (_req, res) => {
    res.json(listEvents());
  });

  // Providers ---------------------------------------------------------------------------
  r.get('/providers', can('configure'), async (_req, res) => {
    res.json(await listProviders());
  });

  r.put('/providers/:channel', can('configure'), async (req, res) => {
    const { channel } = parse(z.object({ channel: externalChannelEnum }), req.params);
    const body = parse(providerBody, req.body);
    const dto = await saveProvider(channel, body);
    await audit({
      action: 'notifications.provider_saved',
      entityType: 'notification_provider',
      entityId: channel,
      metadata: {
        provider: body.provider,
        isActive: body.isActive,
        secretsChanged: Object.keys(body.settings).filter((k) => body.settings[k] && dto.secretHints[k]),
      },
    });
    res.json(dto);
  });

  r.delete('/providers/:channel', can('configure'), async (req, res) => {
    const { channel } = parse(z.object({ channel: externalChannelEnum }), req.params);
    const row = await providerRepo.findOne({ where: { channel } });
    if (row) {
      await providerRepo.destroy(row.id);
      await audit({
        action: 'notifications.provider_removed',
        entityType: 'notification_provider',
        entityId: channel,
      });
    }
    res.json(toProviderDto(channel, null));
  });

  r.post('/providers/:channel/test', can('configure'), async (req, res) => {
    const { channel } = parse(z.object({ channel: externalChannelEnum }), req.params);
    const { to, templateId, body } = parse(
      z.object({
        to: z.string().trim().min(3).max(512),
        /** Vendor template: WhatsApp `name:language` (e.g. `hello_world:en_US`), a DLT or Content template id. */
        templateId: z.string().trim().max(190).optional(),
        /** Text of an approved SMS template (DLT requires the exact wording). */
        body: z.string().trim().min(1).max(1000).optional(),
      }),
      req.body,
    );
    const { provider } = await resolveProvider(channel);
    try {
      const result = await provider.send({
        to,
        subject: 'Test message',
        body: body ?? 'Test message from your ERP.',
        templateId: templateId || undefined,
      });
      res.json({ ok: result.status !== 'failed', provider: provider.name, ...result });
    } catch (err) {
      res.json({
        ok: false,
        provider: provider.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Checks the saved credentials with the vendor without sending a message (where the vendor allows it). */
  r.post('/providers/:channel/verify', can('configure'), async (req, res) => {
    const { channel } = parse(z.object({ channel: externalChannelEnum }), req.params);
    res.json(await verifyProvider(channel));
  });

  // Templates ---------------------------------------------------------------------------
  r.get('/templates', can('view'), async (req, res) => {
    const q = parse(z.object({ eventKey: z.string().max(80).optional() }), req.query);
    const rows = await templateRepo.findAll({
      where: q.eventKey ? { eventKey: q.eventKey } : {},
      order: [
        ['eventKey', 'ASC'],
        ['channel', 'ASC'],
      ],
    });
    res.json(rows.map(templateDto));
  });

  r.post('/templates/preview', can('view'), (req, res) => {
    const body = parse(
      z.object({ eventKey, subject: z.string().max(255).nullable().optional(), body: z.string().max(4000) }),
      req.body,
    );
    const vars = sampleVars(getEvent(body.eventKey).variables);
    res.json({
      subject: body.subject ? renderTemplate(body.subject, vars) : null,
      body: renderTemplate(body.body, vars),
    });
  });

  r.post('/templates', can('edit'), async (req, res) => {
    const body = parse(templateBody, req.body);
    if (await templateRepo.findOne({ where: { eventKey: body.eventKey, channel: body.channel } }))
      throw Conflict('A template for this event and channel already exists', 'TEMPLATE_EXISTS');
    const t = await templateRepo.create({
      eventKey: body.eventKey,
      channel: body.channel,
      subject: body.subject ?? null,
      body: body.body,
      providerTemplateId: body.providerTemplateId ?? null,
      isActive: body.isActive,
    });
    await audit({
      action: 'notifications.template_created',
      entityType: 'notification_template',
      entityId: t.id,
    });
    res.status(201).json(templateDto(t));
  });

  r.patch('/templates/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(templateBody.omit({ eventKey: true, channel: true }).partial(), req.body);
    const before = templateDto(await templateRepo.findById(id));
    const t = await templateRepo.update(id, body);
    await audit({
      action: 'notifications.template_updated',
      entityType: 'notification_template',
      entityId: id,
      metadata: { before, after: templateDto(t) },
    });
    res.json(templateDto(t));
  });

  r.delete('/templates/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const t = await templateRepo.destroy(id);
    await audit({
      action: 'notifications.template_deleted',
      entityType: 'notification_template',
      entityId: id,
      metadata: { before: templateDto(t) },
    });
    res.status(204).end();
  });

  // Trigger rules -----------------------------------------------------------------------
  r.get('/rules', can('view'), async (_req, res) => {
    res.json(await Promise.all(listEvents().map((e) => effectiveRule(e.key))));
  });

  r.put('/rules/:eventKey', can('edit'), async (req, res) => {
    const { eventKey: key } = parse(z.object({ eventKey }), req.params);
    const body = parse(ruleBody, req.body);
    const values = {
      channels: unique(body.channels),
      recipientTypes: unique(body.recipientTypes),
      isActive: body.isActive,
    };
    const before = await effectiveRule(key);
    const existing = await ruleRepo.findOne({ where: { eventKey: key } });
    if (existing) await ruleRepo.update(existing.id, values);
    else await ruleRepo.create({ eventKey: key, ...values });
    const after = await effectiveRule(key);
    await audit({
      action: 'notifications.rule_updated',
      entityType: 'notification_rule',
      entityId: key,
      metadata: { before, after },
    });
    res.json(after);
  });

  r.delete('/rules/:eventKey', can('edit'), async (req, res) => {
    const { eventKey: key } = parse(z.object({ eventKey }), req.params);
    const existing = await ruleRepo.findOne({ where: { eventKey: key } });
    if (existing) {
      await ruleRepo.destroy(existing.id);
      await audit({ action: 'notifications.rule_reset', entityType: 'notification_rule', entityId: key });
    }
    res.json(await effectiveRule(key));
  });

  // Delivery history --------------------------------------------------------------------
  r.get('/messages', can('view'), async (req, res) => {
    const q = parse(historyQuery, req.query);
    const where: Record<string | symbol, unknown> = {};
    for (const k of ['status', 'channel', 'eventKey', 'userId', 'campaignId'] as const)
      if (q[k]) where[k] = q[k];
    if (q.search) {
      where[Op.or] = [
        { recipientAddress: { [Op.like]: `%${q.search}%` } },
        { body: { [Op.like]: `%${q.search}%` } },
      ];
    }
    const { rows, count } = await historyRepo.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    const names = await userNames(rows.map((m) => m.userId));
    res.json(
      paginated(
        rows.map((m) => messageDto(m, names)),
        count,
        q,
      ),
    );
  });

  r.get('/messages/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const m = await historyRepo.findById(id);
    const attempts = await attemptRepo.findAll({ where: { messageId: id }, order: [['attemptNo', 'ASC']] });
    res.json({
      ...messageDto(m, await userNames([m.userId])),
      deliveryAttempts: attempts.map((a) => ({
        id: a.id,
        attemptNo: a.attemptNo,
        status: a.status,
        provider: a.provider,
        providerMessageId: a.providerMessageId,
        error: a.error,
        durationMs: a.durationMs,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  });

  r.post('/messages/:id/retry', can('create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const m = await historyRepo.findById(id);
    if (m.status !== 'failed') throw BadRequest('Only failed messages can be retried');
    await retryMessage(id);
    await audit({
      action: 'notifications.message_retried',
      entityType: 'notification_message',
      entityId: id,
    });
    res.json(messageDto(await historyRepo.findById(id), await userNames([m.userId])));
  });

  // Compose / bulk / scheduled ------------------------------------------------------------
  r.get('/campaigns', can('view'), async (req, res) => {
    const q = parse(paginationSchema, req.query);
    const { rows, count } = await campaignRepo.findAndCountAll({
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(campaignDto), count, q));
  });

  r.get('/campaigns/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(campaignDto(await campaignRepo.findById(id)));
  });

  /** Branch-limited senders must target exactly one of their branches. */
  function audienceBranches(audience: z.infer<typeof campaignAudience>): number[] {
    const { allowedBranchIds } = requireTenantContext();
    const branchIds = unique(audience.branchIds ?? []);
    if (allowedBranchIds !== null && (branchIds.length !== 1 || !allowedBranchIds.includes(branchIds[0]!)))
      throw Forbidden('Choose one of your branches as the audience', 'BRANCH_FORBIDDEN');
    return branchIds;
  }

  // How many people an audience reaches, shown in compose before sending.
  r.post('/campaigns/preview', can('create'), async (req, res) => {
    const { audience } = parse(z.object({ audience: campaignAudience }), req.body);
    const branchIds = audienceBranches(audience);
    const recipients = await resolveAudience({ ...audience, branchIds });
    res.json({ recipients: recipients.size });
  });

  r.post('/campaigns', can('create'), async (req, res) => {
    const body = parse(campaignBody, req.body);
    const branchIds = audienceBranches(body.audience);
    if (body.scheduledAt && body.scheduledAt.getTime() < Date.now() - 60_000)
      throw BadRequest('Scheduled time is in the past');
    const campaign = await createCampaign({
      title: body.title,
      channels: unique(body.channels),
      subject: body.subject ?? null,
      body: body.body,
      audience: { ...body.audience, branchIds },
      scheduledAt: body.scheduledAt ?? null,
      branchId: branchIds.length === 1 ? branchIds[0]! : null,
    });
    await audit({
      action: 'notifications.campaign_created',
      entityType: 'notification_campaign',
      entityId: campaign.id,
      metadata: {
        channels: campaign.channels,
        audience: campaign.audience,
        scheduledAt: campaign.scheduledAt,
      },
    });
    res.status(201).json(campaignDto(campaign));
  });

  r.post('/campaigns/:id/cancel', can('create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const c = await campaignRepo.findById(id);
    if (c.status !== 'scheduled') throw BadRequest('Only scheduled messages can be cancelled');
    await c.update({ status: 'cancelled' });
    await audit({
      action: 'notifications.campaign_cancelled',
      entityType: 'notification_campaign',
      entityId: id,
    });
    res.json(campaignDto(c));
  });
}

const webhookKeyParams = z.object({ webhookKey: z.string().min(10).max(80) });
const rawBody = express.raw({ type: () => true, limit: '1mb' });

/**
 * Vendor delivery-status and inbound-message webhooks. Unauthenticated: the provider is resolved from
 * the secret key in the URL and the vendor's signature is verified before anything is trusted.
 */
function publicWebhookRoutes(api: Router) {
  const base = '/notifications/public/webhooks';
  const handle = (vendor: MessagingWebhookVendor) => async (req: Request, res: Response) => {
    const { webhookKey } = parse(webhookKeyParams, req.params);
    const raw =
      req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
    const query = req.originalUrl.indexOf('?');
    const result = await processMessagingWebhook({
      vendor,
      webhookKey,
      rawBody: raw,
      headers: req.headers,
      search: query >= 0 ? req.originalUrl.slice(query) : '',
    });
    // Twilio treats the response to an inbound message as TwiML; an empty one sends no reply.
    if (vendor === 'twilio') res.type('text/xml').send('<Response></Response>');
    else res.json({ received: true, ...result });
  };
  api.get(`${base}/whatsapp-cloud/:webhookKey`, webhookRateLimit, async (req, res) => {
    const { webhookKey } = parse(webhookKeyParams, req.params);
    res.type('text/plain').send(await whatsappHandshake(webhookKey, req.query as Record<string, unknown>));
  });
  api.post(`${base}/whatsapp-cloud/:webhookKey`, webhookRateLimit, rawBody, handle('whatsapp-cloud'));
  api.post(`${base}/twilio/:webhookKey`, webhookRateLimit, rawBody, handle('twilio'));
  api.post(`${base}/msg91/:webhookKey`, webhookRateLimit, rawBody, handle('msg91'));
}

export function notificationRoutes(api: Router) {
  publicWebhookRoutes(api);
  const r = Router();
  r.use(authenticate);
  platformInboxRoutes(r);
  inboxRoutes(r);
  notificationAdminRoutes(r);
  api.use('/notifications', r);
}
