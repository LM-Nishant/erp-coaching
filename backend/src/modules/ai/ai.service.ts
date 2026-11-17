import { Op } from 'sequelize';
import {
  AI_PROVIDER_PRESETS,
  type AiProviderId,
  type AiSettingsDto,
  type AiSettingsUpdate,
  type AiTestResult,
} from '@erp/shared';
import { config } from '../../infrastructure/config';
import { decryptSecret, encryptSecret, maskSecret } from '../../infrastructure/crypto';
import {
  AiProviderError,
  chatCompletion,
  type ChatRequest,
  type ChatResponse,
  type ProviderConnection,
} from '../../infrastructure/ai-providers/openai-compatible.client';
import { AppError } from '../../shared/errors';
import { getContext } from '../../shared/context';
import { getPlanLimits } from '../subscriptions/subscription.service';
import { AiSetting, AiUsage } from './models';

const SCOPE = 'global';

function inferProvider(baseUrl: string): AiProviderId {
  if (/\.openai\.azure\.com/i.test(baseUrl)) return 'azure-openai';
  return AI_PROVIDER_PRESETS.find((p) => baseUrl.startsWith(p.baseUrl))?.id ?? 'custom';
}

/** Effective connection: DB settings first, falling back to env AI_BASE_URL / AI_MODEL / AI_API_KEY. */
export async function getConnection(): Promise<
  ProviderConnection & { jsonMode: boolean; keySource: AiSettingsDto['keySource'] }
> {
  const row = await AiSetting.findOne({ where: { scope: SCOPE } });
  const baseUrl = row?.baseUrl ?? config.AI_BASE_URL;
  const dbKey = row?.apiKeyEncrypted ? decryptSecret(row.apiKeyEncrypted) : null;
  const apiKey = dbKey ?? config.AI_API_KEY ?? null;
  return {
    provider: row?.provider ?? inferProvider(baseUrl),
    baseUrl,
    model: row?.model ?? config.AI_MODEL,
    apiKey,
    jsonMode: row?.jsonMode ?? true,
    timeoutMs: config.AI_TIMEOUT_MS,
    keySource: dbKey ? 'database' : config.AI_API_KEY ? 'env' : 'none',
  };
}

/** Browser-safe view. The API key itself is NEVER returned — only a masked hint. */
export async function getSettingsDto(): Promise<AiSettingsDto> {
  const conn = await getConnection();
  const row = await AiSetting.findOne({ where: { scope: SCOPE } });
  return {
    provider: conn.provider,
    baseUrl: conn.baseUrl,
    model: conn.model,
    jsonMode: conn.jsonMode,
    hasKey: !!conn.apiKey,
    keyHint: conn.apiKey ? maskSecret(conn.apiKey) : null,
    keySource: conn.keySource,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

/** Empty/omitted apiKey keeps the stored key. */
export async function updateSettings(input: AiSettingsUpdate, userId: number | null): Promise<AiSettingsDto> {
  const existing = await AiSetting.findOne({ where: { scope: SCOPE } });
  const values = {
    provider: input.provider,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model: input.model.trim(),
    jsonMode: input.jsonMode,
    updatedBy: userId,
    ...(input.apiKey && input.apiKey.trim() ? { apiKeyEncrypted: encryptSecret(input.apiKey.trim()) } : {}),
  };
  if (existing) await existing.update(values);
  else await AiSetting.create({ scope: SCOPE, apiKeyEncrypted: null, ...values });
  return getSettingsDto();
}

export async function removeStoredKey(userId: number | null) {
  await AiSetting.update({ apiKeyEncrypted: null, updatedBy: userId }, { where: { scope: SCOPE } });
}

function startOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function tokensUsedThisMonth(instituteId: number): Promise<number> {
  return Number(
    (await AiUsage.sum('totalTokens', { where: { instituteId, createdAt: { [Op.gte]: startOfMonth() } } })) ||
      0,
  );
}

/** Quota hook: throws 429 AI_QUOTA_EXCEEDED when the institute's monthly AI token allowance is used up. */
export async function assertAiQuota(instituteId: number) {
  const limits = await getPlanLimits(instituteId);
  if (limits.enabledModules && !limits.enabledModules.includes('ai')) {
    throw new AppError(403, 'MODULE_DISABLED', 'AI features are not included in your plan');
  }
  if (limits.aiTokensMonthly === null) return;
  const used = await tokensUsedThisMonth(instituteId);
  if (used >= limits.aiTokensMonthly) {
    throw new AppError(429, 'AI_QUOTA_EXCEEDED', 'Monthly AI usage limit reached for this institute', {
      used,
      limit: limits.aiTokensMonthly,
    });
  }
}

export interface AiChatOptions extends ChatRequest {
  /** Feature key for metering, e.g. `exams.question-generator`. */
  feature: string;
  /** Override; defaults to the current request's institute. */
  instituteId?: number | null;
  /** Skip the quota check (platform tests only). */
  skipQuota?: boolean;
}

/**
 * The one entry point other modules use for AI. Applies quota, calls the configured
 * OpenAI-compatible provider and records usage (success or failure) in `ai_usage`.
 */
export async function aiChat(opts: AiChatOptions): Promise<ChatResponse> {
  const ctx = getContext();
  const instituteId = opts.instituteId !== undefined ? opts.instituteId : (ctx.instituteId ?? null);
  if (instituteId && !opts.skipQuota) await assertAiQuota(instituteId);
  const conn = await getConnection();
  if (!conn.apiKey && conn.provider !== 'ollama') {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI provider API key is not configured');
  }
  const jsonMode = opts.jsonMode ?? conn.jsonMode;
  const base = {
    instituteId,
    userId: ctx.userId ?? null,
    feature: opts.feature,
    provider: conn.provider,
    model: conn.model,
  };
  try {
    const result = await chatCompletion(conn, { ...opts, jsonMode });
    await AiUsage.create({
      ...base,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      status: 'success',
      latencyMs: result.latencyMs,
      error: null,
    });
    return result;
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
  const jsonMode = input.jsonMode ?? current.jsonMode;
  try {
    const res = await chatCompletion(conn, {
      messages: [
        {
          role: 'system',
          content: jsonMode ? 'Reply with a JSON object {"ok": true}.' : 'Reply with the single word OK.',
        },
        { role: 'user', content: 'ping' },
      ],
      jsonMode,
      maxTokens: 20,
    });
    await AiUsage.create({
      instituteId: null,
      userId: getContext().userId ?? null,
      feature: 'ai.test-connection',
      provider: conn.provider,
      model: res.model,
      promptTokens: res.usage.promptTokens,
      completionTokens: res.usage.completionTokens,
      totalTokens: res.usage.totalTokens,
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
