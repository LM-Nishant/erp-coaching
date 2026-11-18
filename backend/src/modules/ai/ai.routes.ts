import { Router } from 'express';
import { Op, fn, col, literal } from 'sequelize';
import { z } from 'zod';
import { AI_PROVIDER_IDS, type AiAdminUsageDto, type AiAdminUsageRow } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { audit } from '../../shared/audit/audit.service';
import { AiUsage } from './models';
import {
  assertAiPlanEnabled,
  getSettingsDto,
  getUsageSummary,
  removeStoredKey,
  testConnection,
  updateSettings,
} from './ai.service';

const price = z.number().min(0).max(100000).nullable().optional();
const settingsSchema = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  baseUrl: z.string().trim().url().max(500),
  model: z.string().trim().min(1).max(150),
  jsonMode: z.boolean(),
  apiKey: z.string().max(4000).optional(),
  inputUsdPer1M: price,
  outputUsdPer1M: price,
});

const num = (v: unknown) => Number(v ?? 0) || 0;
const usageColumns = [
  [fn('COUNT', col('id')), 'calls'],
  [fn('SUM', literal("CASE WHEN status = 'error' THEN 1 ELSE 0 END")), 'errors'],
  [fn('SUM', col('prompt_tokens')), 'promptTokens'],
  [fn('SUM', col('completion_tokens')), 'completionTokens'],
  [fn('SUM', col('total_tokens')), 'totalTokens'],
  [fn('SUM', col('image_count')), 'images'],
  [fn('SUM', col('estimated_cost_usd')), 'estimatedCostUsd'],
] as const;
function usageRow(r: Record<string, unknown>): Omit<AiAdminUsageRow, 'instituteId'> {
  return {
    calls: num(r.calls),
    errors: num(r.errors),
    promptTokens: num(r.promptTokens),
    completionTokens: num(r.completionTokens),
    totalTokens: num(r.totalTokens),
    images: num(r.images),
    estimatedCostUsd: Math.round(num(r.estimatedCostUsd) * 1e6) / 1e6,
  };
}

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
        inputUsdPer1M: body.inputUsdPer1M,
        outputUsdPer1M: body.outputUsdPer1M,
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
    const where = { createdAt: { [Op.gte]: since } };
    const [institutes, providers] = (await Promise.all([
      AiUsage.findAll({
        attributes: ['instituteId', ...usageColumns],
        where,
        group: ['instituteId'],
        raw: true,
      }),
      AiUsage.findAll({
        attributes: ['provider', 'model', ...usageColumns],
        where,
        group: ['provider', 'model'],
        raw: true,
      }),
    ])) as unknown as Record<string, unknown>[][];
    const body: AiAdminUsageDto = {
      since: since.toISOString(),
      byInstitute: institutes.map((r) => ({
        instituteId: r.instituteId == null ? null : Number(r.instituteId),
        ...usageRow(r),
      })),
      byProvider: providers.map((r) => ({
        provider: String(r.provider),
        model: String(r.model),
        ...usageRow(r),
      })),
    };
    res.json(body);
  });

  api.use('/admin/ai', admin);

  /** Current-month usage, remaining quota and provider status for the institute. */
  api.get('/ai/usage', authenticate, requirePermission('ai', 'view'), async (_req, res) => {
    res.json(await getUsageSummary(requireTenantContext().instituteId));
  });

  /** The institute's own calls, tokens and cost over the last `days`, overall and per provider/model. */
  api.get('/ai/usage/history', authenticate, requirePermission('ai', 'view'), async (req, res) => {
    const { instituteId } = requireTenantContext();
    await assertAiPlanEnabled(instituteId);
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const since = new Date(Date.now() - q.days * 86400000);
    const where = { instituteId, createdAt: { [Op.gte]: since } };
    const [totals, providers] = (await Promise.all([
      AiUsage.findAll({ attributes: [...usageColumns], where, raw: true }),
      AiUsage.findAll({
        attributes: ['provider', 'model', ...usageColumns],
        where,
        group: ['provider', 'model'],
        order: [
          ['provider', 'ASC'],
          ['model', 'ASC'],
        ],
        raw: true,
      }),
    ])) as unknown as Record<string, unknown>[][];
    const body: AiAdminUsageDto = {
      since: since.toISOString(),
      byInstitute: [{ instituteId, ...usageRow(totals[0] ?? {}) }],
      byProvider: providers.map((r) => ({
        provider: String(r.provider),
        model: String(r.model),
        ...usageRow(r),
      })),
    };
    res.json(body);
  });
}
