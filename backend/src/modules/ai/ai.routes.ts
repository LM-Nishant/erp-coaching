import { Router } from 'express';
import { Op, fn, col } from 'sequelize';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { audit } from '../../shared/audit/audit.service';
import { getPlanLimits } from '../subscriptions/subscription.service';
import { AiUsage } from './models';
import {
  getSettingsDto,
  removeStoredKey,
  testConnection,
  tokensUsedThisMonth,
  updateSettings,
} from './ai.service';

const providerEnum = z.enum(['openai', 'azure-openai', 'gemini', 'groq', 'openrouter', 'ollama', 'custom']);
const settingsSchema = z.object({
  provider: providerEnum,
  baseUrl: z.string().trim().url().max(500),
  model: z.string().trim().min(1).max(150),
  jsonMode: z.boolean(),
  apiKey: z.string().max(4000).optional(),
});

export function aiRoutes(api: Router) {
  const admin = Router();
  admin.use(authenticate, requireSuperAdmin);

  admin.get('/settings', async (_req, res) => {
    res.json(await getSettingsDto());
  });

  admin.put('/settings', async (req, res) => {
    const body = parse(settingsSchema, req.body);
    const dto = await updateSettings(body, req.ctx.userId ?? null);
    await audit({
      action: 'ai.settings_updated',
      entityType: 'ai_settings',
      instituteId: null,
      metadata: {
        provider: body.provider,
        baseUrl: body.baseUrl,
        model: body.model,
        jsonMode: body.jsonMode,
        keyChanged: !!body.apiKey?.trim(),
      },
    });
    res.json(dto);
  });

  admin.delete('/settings/key', async (req, res) => {
    await removeStoredKey(req.ctx.userId ?? null);
    await audit({ action: 'ai.key_removed', entityType: 'ai_settings', instituteId: null });
    res.json(await getSettingsDto());
  });

  admin.post('/settings/test', async (req, res) => {
    res.json(await testConnection(parse(settingsSchema.partial(), req.body ?? {})));
  });

  admin.get('/usage', async (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const since = new Date(Date.now() - q.days * 86400000);
    const rows = await AiUsage.findAll({
      attributes: [
        'instituteId',
        [fn('COUNT', col('id')), 'calls'],
        [fn('SUM', col('total_tokens')), 'totalTokens'],
        [fn('SUM', col('prompt_tokens')), 'promptTokens'],
        [fn('SUM', col('completion_tokens')), 'completionTokens'],
      ],
      where: { createdAt: { [Op.gte]: since } },
      group: ['instituteId'],
      raw: true,
    });
    res.json({ since, byInstitute: rows });
  });

  api.use('/admin/ai', admin);

  api.get('/ai/usage', authenticate, requirePermission('ai', 'view'), async (_req, res) => {
    const { instituteId } = requireTenantContext();
    const limits = await getPlanLimits(instituteId);
    res.json({
      tokensThisMonth: await tokensUsedThisMonth(instituteId),
      monthlyLimit: limits.aiTokensMonthly,
    });
  });
}
