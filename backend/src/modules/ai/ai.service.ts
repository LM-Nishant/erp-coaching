import { Op, fn, col, literal } from 'sequelize';
import {
  AI_PROVIDER_PRESETS,
  MOCK_AI_BASE_URL,
  MOCK_AI_MODEL,
  type AiAvailabilityDto,
  type AiMockReason,
  type AiProviderId,
  type AiSettingsDto,
  type AiSettingsUpdate,
  type AiTestResult,
  type AiUsageFeatureRow,
  type AiUsageSummaryDto,
  type PlanLimits,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import { logger } from '../../infrastructure/logger';
import { decryptSecret, encryptSecret, maskSecret } from '../../infrastructure/crypto';
import {
  AiProviderError,
  chatCompletion,
  type ChatRequest,
  type ChatResponse,
  type ProviderConnection,
} from '../../infrastructure/ai-providers/openai-compatible.client';
import { countImages, mockChatCompletion } from '../../infrastructure/ai-providers/mock.client';
import { AppError } from '../../shared/errors';
import { getContext } from '../../shared/context';
import { getInstituteTimezone, todayIn, zonedDateTimeToUtc } from '../../shared/timezone';
import { getPlanLimits } from '../subscriptions/subscription.service';
import { AiSetting, AiUsage } from './models';

const SCOPE = 'global';

function inferProvider(baseUrl: string): AiProviderId {
  if (/\.openai\.azure\.com/i.test(baseUrl)) return 'azure-openai';
  return AI_PROVIDER_PRESETS.find((p) => baseUrl.startsWith(p.baseUrl))?.id ?? 'custom';
}

/** The mock provider is a development/test tool: it can never run in production. */
export const isMockAllowed = () => !config.isProd;
/** Dev/test: use the mock while no API key is configured (`AI_MOCK_FALLBACK`). */
export const isMockFallbackEnabled = () => isMockAllowed() && config.AI_MOCK_FALLBACK;

const needsKey = (provider: AiProviderId) => provider !== 'ollama' && provider !== 'mock';

export interface StoredConnection extends ProviderConnection {
  jsonMode: boolean;
  keySource: AiSettingsDto['keySource'];
  inputUsdPer1M: number | null;
  outputUsdPer1M: number | null;
}

/** Configured connection: DB settings first, falling back to env AI_BASE_URL / AI_MODEL / AI_API_KEY. */
export async function getConnection(): Promise<StoredConnection> {
  const row = await AiSetting.findOne({ where: { scope: SCOPE } });
  const baseUrl = row?.baseUrl ?? config.AI_BASE_URL;
  const dbKey = row?.apiKeyEncrypted ? decryptSecret(row.apiKeyEncrypted) : null;
  const apiKey = dbKey ?? config.AI_API_KEY ?? null;
  return {
    provider: row?.provider ?? inferProvider(baseUrl),
    baseUrl,
    model: row?.model ?? config.AI_MODEL,
    apiKey: apiKey || null,
    jsonMode: row?.jsonMode ?? true,
    timeoutMs: config.AI_TIMEOUT_MS,
    keySource: dbKey ? 'database' : config.AI_API_KEY ? 'env' : 'none',
    inputUsdPer1M: row?.inputUsdPer1M ?? null,
    outputUsdPer1M: row?.outputUsdPer1M ?? null,
  };
}

export interface AiPricing {
  inputUsdPer1M: number | null;
  outputUsdPer1M: number | null;
  source: AiSettingsDto['pricingSource'];
}

/** Price overrides from settings, else the preset list price when the preset model is in use. */
function pricingFor(c: {
  provider: AiProviderId;
  model: string;
  inputUsdPer1M?: number | null;
  outputUsdPer1M?: number | null;
}): AiPricing {
  if (c.inputUsdPer1M != null || c.outputUsdPer1M != null) {
    return { inputUsdPer1M: c.inputUsdPer1M ?? 0, outputUsdPer1M: c.outputUsdPer1M ?? 0, source: 'settings' };
  }
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === c.provider);
  const anyModel = c.provider === 'mock' || c.provider === 'ollama';
  if (preset?.inputUsdPer1M != null && (anyModel || preset.model === c.model)) {
    return {
      inputUsdPer1M: preset.inputUsdPer1M,
      outputUsdPer1M: preset.outputUsdPer1M ?? 0,
      source: 'preset',
    };
  }
  return { inputUsdPer1M: null, outputUsdPer1M: null, source: 'none' };
}

export function estimateCostUsd(
  pricing: Pick<AiPricing, 'inputUsdPer1M' | 'outputUsdPer1M'>,
  usage: { promptTokens: number; completionTokens: number },
): number {
  const cost =
    (usage.promptTokens * (pricing.inputUsdPer1M ?? 0) +
      usage.completionTokens * (pricing.outputUsdPer1M ?? 0)) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export interface EffectiveConnection extends StoredConnection {
  /** Set when the mock is in use: chosen explicitly, or the dev/test fallback for a missing key. */
  mockReason: AiMockReason | null;
  /** Why AI calls can't be made right now; null when they can. */
  unavailable: string | null;
  pricing: AiPricing;
}

let fallbackLogged = false;

/**
 * The connection AI calls actually use. The mock is used only when selected (outside production)
 * or as the dev/test fallback when the configured provider has no key. A configured real provider
 * is never replaced by the mock, and provider errors never fall back.
 */
export async function resolveConnection(stored?: StoredConnection): Promise<EffectiveConnection> {
  const conn = stored ?? (await getConnection());
  if (conn.provider === 'mock') {
    return {
      ...conn,
      apiKey: null,
      mockReason: 'selected',
      unavailable: isMockAllowed()
        ? null
        : 'The mock AI provider cannot be used in production. Configure a real AI provider.',
      pricing: pricingFor(conn),
    };
  }
  if (!conn.apiKey && needsKey(conn.provider)) {
    if (isMockFallbackEnabled()) {
      if (!fallbackLogged) {
        fallbackLogged = true;
        logger.warn('AI: no API key configured, using the built-in mock provider (AI_MOCK_FALLBACK)');
      }
      const mock = { provider: 'mock' as const, baseUrl: MOCK_AI_BASE_URL, model: MOCK_AI_MODEL };
      return {
        ...conn,
        ...mock,
        apiKey: null,
        mockReason: 'fallback',
        unavailable: null,
        pricing: pricingFor(mock),
      };
    }
    return {
      ...conn,
      mockReason: null,
      unavailable: 'AI provider API key is not configured',
      pricing: pricingFor(conn),
    };
  }
  return { ...conn, mockReason: null, unavailable: null, pricing: pricingFor(conn) };
}

/** Browser-safe view. The API key itself is NEVER returned — only a masked hint. */
export async function getSettingsDto(): Promise<AiSettingsDto> {
  const conn = await getConnection();
  const effective = await resolveConnection(conn);
  const row = await AiSetting.findOne({ where: { scope: SCOPE } });
  const pricing = pricingFor(conn);
  return {
    provider: conn.provider,
    baseUrl: conn.baseUrl,
    model: conn.model,
    jsonMode: conn.jsonMode,
    hasKey: !!conn.apiKey,
    keyHint: conn.apiKey ? maskSecret(conn.apiKey) : null,
    keySource: conn.keySource,
    effectiveProvider: effective.provider,
    effectiveModel: effective.model,
    mockReason: effective.mockReason,
    mockAllowed: isMockAllowed(),
    inputUsdPer1M: pricing.inputUsdPer1M,
    outputUsdPer1M: pricing.outputUsdPer1M,
    pricingSource: pricing.source,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

function assertProviderAllowed(provider: AiProviderId | undefined) {
  if (provider === 'mock' && !isMockAllowed()) {
    throw new AppError(400, 'MOCK_AI_NOT_ALLOWED', 'The mock AI provider is not available in production');
  }
}

/** Empty/omitted apiKey keeps the stored key; omitted prices keep the stored overrides. */
export async function updateSettings(input: AiSettingsUpdate, userId: number | null): Promise<AiSettingsDto> {
  assertProviderAllowed(input.provider);
  const existing = await AiSetting.findOne({ where: { scope: SCOPE } });
  const values = {
    provider: input.provider,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model: input.model.trim(),
    jsonMode: input.jsonMode,
    updatedBy: userId,
    ...(input.apiKey && input.apiKey.trim() ? { apiKeyEncrypted: encryptSecret(input.apiKey.trim()) } : {}),
    ...(input.inputUsdPer1M !== undefined ? { inputUsdPer1M: input.inputUsdPer1M } : {}),
    ...(input.outputUsdPer1M !== undefined ? { outputUsdPer1M: input.outputUsdPer1M } : {}),
  };
  if (existing) await existing.update(values);
  else await AiSetting.create({ scope: SCOPE, apiKeyEncrypted: null, ...values });
  return getSettingsDto();
}

export async function removeStoredKey(userId: number | null) {
  await AiSetting.update({ apiKeyEncrypted: null, updatedBy: userId }, { where: { scope: SCOPE } });
}

/** Start of the institute's current metering month (1st, 00:00 in the institute timezone). */
export async function usagePeriodStart(instituteId: number, now = new Date()): Promise<Date> {
  const tz = await getInstituteTimezone(instituteId);
  return zonedDateTimeToUtc(`${todayIn(tz, now).slice(0, 8)}01`, '00:00', tz);
}

export async function tokensUsedThisMonth(instituteId: number, now = new Date()): Promise<number> {
  const since = await usagePeriodStart(instituteId, now);
  return Number(
    (await AiUsage.sum('totalTokens', { where: { instituteId, createdAt: { [Op.gte]: since } } })) || 0,
  );
}

/** Throws 403 MODULE_DISABLED when the institute's plan does not include AI features. */
export async function assertAiPlanEnabled(instituteId: number): Promise<PlanLimits> {
  const limits = await getPlanLimits(instituteId);
  if (limits.enabledModules && !limits.enabledModules.includes('ai')) {
    throw new AppError(403, 'MODULE_DISABLED', 'AI features are not included in your plan');
  }
  return limits;
}

/** Quota hook: throws 429 AI_QUOTA_EXCEEDED when the institute's monthly AI token allowance is used up. */
export async function assertAiQuota(instituteId: number) {
  const limits = await assertAiPlanEnabled(instituteId);
  if (limits.aiTokensMonthly === null) return;
  const used = await tokensUsedThisMonth(instituteId);
  if (used >= limits.aiTokensMonthly) {
    throw new AppError(429, 'AI_QUOTA_EXCEEDED', 'Monthly AI usage limit reached for this institute', {
      used,
      limit: limits.aiTokensMonthly,
      remaining: 0,
    });
  }
}

/** Whether AI features can run for the institute now (plan, provider, quota) and the remaining quota. */
export async function getAiAvailability(instituteId: number): Promise<AiAvailabilityDto> {
  const conn = await resolveConnection();
  let limits: PlanLimits | null = null;
  let reason: AiAvailabilityDto['reason'] = null;
  try {
    limits = await getPlanLimits(instituteId);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    reason = 'SUBSCRIPTION_INACTIVE';
  }
  const used = await tokensUsedThisMonth(instituteId);
  const limit = limits?.aiTokensMonthly ?? null;
  if (!reason && limits?.enabledModules && !limits.enabledModules.includes('ai')) reason = 'MODULE_DISABLED';
  else if (!reason && conn.unavailable) reason = 'AI_NOT_CONFIGURED';
  else if (!reason && limit !== null && used >= limit) reason = 'AI_QUOTA_EXCEEDED';
  return {
    available: !reason,
    reason,
    provider: conn.provider,
    model: conn.model,
    mock: conn.provider === 'mock',
    tokensUsed: used,
    monthlyLimit: limit,
    remainingTokens: limit === null ? null : Math.max(0, limit - used),
  };
}

const num = (v: unknown) => Number(v ?? 0) || 0;

/** Usage aggregates for the institute's current month, per feature. */
export async function getUsageSummary(instituteId: number): Promise<AiUsageSummaryDto> {
  const since = await usagePeriodStart(instituteId);
  const availability = await getAiAvailability(instituteId);
  const rows = (await AiUsage.findAll({
    attributes: [
      'feature',
      [fn('COUNT', col('id')), 'requests'],
      [fn('SUM', literal("CASE WHEN status = 'error' THEN 1 ELSE 0 END")), 'errors'],
      [fn('SUM', col('prompt_tokens')), 'promptTokens'],
      [fn('SUM', col('completion_tokens')), 'completionTokens'],
      [fn('SUM', col('total_tokens')), 'totalTokens'],
      [fn('SUM', col('image_count')), 'images'],
      [fn('SUM', col('estimated_cost_usd')), 'estimatedCostUsd'],
    ],
    where: { instituteId, createdAt: { [Op.gte]: since } },
    group: ['feature'],
    order: [['feature', 'ASC']],
    raw: true,
  })) as unknown as Record<string, unknown>[];
  const byFeature: AiUsageFeatureRow[] = rows.map((r) => ({
    feature: String(r.feature),
    requests: num(r.requests),
    errors: num(r.errors),
    totalTokens: num(r.totalTokens),
    images: num(r.images),
    estimatedCostUsd: Math.round(num(r.estimatedCostUsd) * 1e6) / 1e6,
  }));
  const sum = (k: string) => rows.reduce((n, r) => n + num(r[k]), 0);
  return {
    ...availability,
    periodStart: since.toISOString(),
    tokensThisMonth: availability.tokensUsed,
    requests: sum('requests'),
    errors: sum('errors'),
    images: sum('images'),
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    estimatedCostUsd: Math.round(sum('estimatedCostUsd') * 1e6) / 1e6,
    byFeature,
  };
}

export interface AiChatOptions extends ChatRequest {
  /** Feature key for metering, e.g. `exams.question-generator`. */
  feature: string;
  /** Override; defaults to the current request's institute. */
  instituteId?: number | null;
  /** Skip the quota check (platform tests only). */
  skipQuota?: boolean;
}

export interface AiChatResult extends ChatResponse {
  /** The `ai_usage` row metering this call. */
  usageId: number;
  provider: AiProviderId;
  mock: boolean;
  imageCount: number;
  estimatedCostUsd: number;
}

/**
 * The one entry point other modules use for AI. Applies quota, calls the effective provider
 * (see `resolveConnection`) and records usage (success or failure) in `ai_usage`.
 */
export async function aiChat(opts: AiChatOptions): Promise<AiChatResult> {
  const ctx = getContext();
  const instituteId = opts.instituteId !== undefined ? opts.instituteId : (ctx.instituteId ?? null);
  if (instituteId && !opts.skipQuota) await assertAiQuota(instituteId);
  const conn = await resolveConnection();
  if (conn.unavailable) throw new AppError(503, 'AI_NOT_CONFIGURED', conn.unavailable);
  const request: ChatRequest = {
    messages: opts.messages,
    jsonMode: opts.jsonMode ?? conn.jsonMode,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  };
  const imageCount = countImages(opts.messages);
  const base = {
    instituteId,
    userId: ctx.userId ?? null,
    feature: opts.feature,
    provider: conn.provider,
    model: conn.model,
    imageCount,
  };
  try {
    const result =
      conn.provider === 'mock' ? mockChatCompletion(conn, request) : await chatCompletion(conn, request);
    const estimatedCostUsd = estimateCostUsd(conn.pricing, result.usage);
    const row = await AiUsage.create({
      ...base,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      estimatedCostUsd,
      status: 'success',
      latencyMs: result.latencyMs,
      error: null,
    });
    return {
      ...result,
      usageId: row.id,
      provider: conn.provider,
      mock: conn.provider === 'mock',
      imageCount,
      estimatedCostUsd,
    };
  } catch (err) {
    await AiUsage.create({
      ...base,
      status: 'error',
      latencyMs: null,
      error: (err as Error).message.slice(0, 500),
    });
    if (err instanceof AiProviderError) throw new AppError(502, 'AI_PROVIDER_ERROR', err.message);
    throw err;
  }
}

/** Test a (possibly unsaved) configuration. Falls back to the stored key when `apiKey` is empty. */
export async function testConnection(input: Partial<AiSettingsUpdate>): Promise<AiTestResult> {
  const started = Date.now();
  const current = await getConnection();
  const conn: ProviderConnection = {
    provider: input.provider ?? current.provider,
    baseUrl: (input.baseUrl ?? current.baseUrl).trim(),
    model: (input.model ?? current.model).trim(),
    apiKey: input.apiKey?.trim() || current.apiKey,
    timeoutMs: Math.min(config.AI_TIMEOUT_MS, 20000),
  };
  if (conn.provider === 'mock' && !isMockAllowed()) {
    return { ok: false, latencyMs: 0, message: 'The mock AI provider is not available in production' };
  }
  const jsonMode = input.jsonMode ?? current.jsonMode;
  try {
    const request: ChatRequest = {
      messages: [
        {
          role: 'system',
          content: jsonMode ? 'Reply with a JSON object {"ok": true}.' : 'Reply with the single word OK.',
        },
        { role: 'user', content: 'ping' },
      ],
      jsonMode,
      maxTokens: 20,
    };
    const res =
      conn.provider === 'mock' ? mockChatCompletion(conn, request) : await chatCompletion(conn, request);
    await AiUsage.create({
      instituteId: null,
      userId: getContext().userId ?? null,
      feature: 'ai.test-connection',
      provider: conn.provider,
      model: res.model,
      promptTokens: res.usage.promptTokens,
      completionTokens: res.usage.completionTokens,
      totalTokens: res.usage.totalTokens,
      estimatedCostUsd: estimateCostUsd(
        pricingFor({ ...conn, inputUsdPer1M: input.inputUsdPer1M, outputUsdPer1M: input.outputUsdPer1M }),
        res.usage,
      ),
      status: 'success',
      latencyMs: res.latencyMs,
      error: null,
    });
    return {
      ok: true,
      model: res.model,
      latencyMs: res.latencyMs,
      message: `Connected. Model replied: ${res.content.slice(0, 120)}`,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, message: (err as Error).message.slice(0, 500) };
  }
}
