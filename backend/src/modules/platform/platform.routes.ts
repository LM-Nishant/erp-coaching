import { Router } from 'express';
import { z } from 'zod';
import { STORAGE_DRIVERS } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireSuperAdmin } from '../../shared/middleware/authorize';
import { audit } from '../../shared/audit/audit.service';
import {
  assertChannel,
  assertGatewayName,
  gatewayDto,
  integrationsDto,
  messagingDto,
  removeGateway,
  removeMessaging,
  saveGateway,
  saveMessaging,
  saveStorage,
  testGatewayConfig,
  testMessagingConfig,
  testStorageConfig,
  verifyMessagingConfig,
} from './platform.service';

const secret = z.string().max(4000).optional();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const gatewaySchema = z.object({
  enabled: z.boolean(),
  isDefault: z.boolean(),
  useForInstitutes: z.boolean(),
  sandbox: z.boolean(),
  merchantId: optionalText(120),
  website: optionalText(60),
  secretKey: secret,
  webhookSecret: secret,
});

const messagingSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  enabled: z.boolean(),
  settings: z.record(z.string(), z.string().max(4000)).default({}),
  testTo: z.string().trim().min(3).max(200).optional(),
});

const storageSchema = z.object({
  driver: z.enum(STORAGE_DRIVERS),
  active: z.boolean(),
  bucket: optionalText(200),
  region: optionalText(60),
  endpoint: z.string().trim().url().max(500).nullable().optional().or(z.literal('')),
  accessKeyId: optionalText(200),
  secretAccessKey: secret,
});

/** Super admin global configuration: SaaS payment gateways, notification providers and storage. */
export function platformRoutes(api: Router) {
  const admin = Router();
  admin.use(authenticate, requireSuperAdmin);

  admin.get('/integrations', async (_req, res) => {
    res.json(await integrationsDto());
  });

  // ---------------------------------------------------------------- payment gateways

  admin.put('/gateways/:gateway', async (req, res) => {
    const gateway = assertGatewayName(String(req.params.gateway));
    const body = parse(gatewaySchema, req.body);
    const dto = await saveGateway(gateway, body, req.ctx.userId ?? null);
    await audit({
      action: 'platform.gateway_updated',
      entityType: 'platform_gateway',
      entityId: gateway,
      instituteId: null,
      metadata: {
        enabled: body.enabled,
        isDefault: body.isDefault,
        useForInstitutes: body.useForInstitutes,
        sandbox: body.sandbox,
        merchantId: dto.merchantId,
        secretChanged: !!body.secretKey?.trim(),
        webhookSecretChanged: !!body.webhookSecret?.trim(),
      },
    });
    res.json(dto);
  });

  admin.post('/gateways/:gateway/test', async (req, res) => {
    const gateway = assertGatewayName(String(req.params.gateway));
    res.json(await testGatewayConfig(gateway, parse(gatewaySchema.partial(), req.body ?? {})));
  });

  admin.delete('/gateways/:gateway', async (req, res) => {
    const gateway = assertGatewayName(String(req.params.gateway));
    if (await removeGateway(gateway))
      await audit({
        action: 'platform.gateway_removed',
        entityType: 'platform_gateway',
        entityId: gateway,
        instituteId: null,
      });
    res.json(gatewayDto(gateway));
  });

  // ---------------------------------------------------------------- notification providers

  admin.put('/messaging/:channel', async (req, res) => {
    const channel = assertChannel(String(req.params.channel));
    const body = parse(messagingSchema, req.body);
    const dto = await saveMessaging(channel, body, req.ctx.userId ?? null);
    await audit({
      action: 'platform.messaging_updated',
      entityType: 'platform_messaging',
      entityId: channel,
      instituteId: null,
      metadata: {
        provider: body.provider,
        enabled: body.enabled,
        settings: dto.settings,
        secretsChanged: Object.keys(dto.secretHints).filter((k) => !!body.settings[k]?.trim()),
      },
    });
    res.json(dto);
  });

  admin.post('/messaging/:channel/test', async (req, res) => {
    const channel = assertChannel(String(req.params.channel));
    const body = parse(
      messagingSchema.partial().extend({
        to: z.string().trim().min(3).max(200),
        templateId: z.string().trim().min(1).max(190).optional(),
        body: z.string().trim().min(1).max(1000).optional(),
      }),
      req.body ?? {},
    );
    res.json(
      await testMessagingConfig(channel, body, body.to, { templateId: body.templateId, body: body.body }),
    );
  });

  // Key check: the vendor accepts the credentials; no message is sent.
  admin.post('/messaging/:channel/verify', async (req, res) => {
    const channel = assertChannel(String(req.params.channel));
    const body = parse(messagingSchema.pick({ provider: true, settings: true }).partial(), req.body ?? {});
    res.json(await verifyMessagingConfig(channel, body));
  });

  admin.delete('/messaging/:channel', async (req, res) => {
    const channel = assertChannel(String(req.params.channel));
    if (await removeMessaging(channel))
      await audit({
        action: 'platform.messaging_removed',
        entityType: 'platform_messaging',
        entityId: channel,
        instituteId: null,
      });
    res.json(messagingDto(channel));
  });

  // ---------------------------------------------------------------- storage

  admin.put('/storage', async (req, res) => {
    const body = parse(storageSchema, req.body);
    const dto = await saveStorage(
      { ...body, endpoint: body.endpoint === '' ? null : body.endpoint },
      req.ctx.userId ?? null,
    );
    await audit({
      action: 'platform.storage_updated',
      entityType: 'platform_storage',
      instituteId: null,
      metadata: {
        driver: body.driver,
        active: body.active,
        bucket: dto.bucket,
        region: dto.region,
        endpoint: dto.endpoint,
        accessKeyId: dto.accessKeyId,
        secretChanged: !!body.secretAccessKey?.trim(),
        effectiveDriver: dto.effectiveDriver,
      },
    });
    res.json(dto);
  });

  admin.post('/storage/test', async (req, res) => {
    const body = parse(storageSchema.partial(), req.body ?? {});
    res.json(await testStorageConfig({ ...body, endpoint: body.endpoint === '' ? null : body.endpoint }));
  });

  api.use('/admin/platform', admin);
}
