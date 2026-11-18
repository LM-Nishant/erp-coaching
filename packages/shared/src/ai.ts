export const AI_PROVIDER_IDS = [
  'openai',
  'azure-openai',
  'gemini',
  'groq',
  'openrouter',
  'ollama',
  'mock',
  'custom',
] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** Built-in deterministic provider (no network). Development and tests only; never used in production. */
export const MOCK_AI_BASE_URL = 'mock://local';
export const MOCK_AI_MODEL = 'mock-ai-1';

export interface AiProviderPreset {
  id: AiProviderId;
  label: string;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
  hint?: string;
  /** List prices (USD per 1M tokens) of the preset model, used for cost estimates unless overridden. */
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
}

/** Any OpenAI-compatible chat completions API. */
export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    requiresKey: true,
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
    model: 'your-deployment-name',
    requiresKey: true,
    hint: 'Replace YOUR-RESOURCE and use your deployment name as the model.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    requiresKey: true,
    inputUsdPer1M: 0.3,
    outputUsdPer1M: 2.5,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    requiresKey: true,
    inputUsdPer1M: 0.59,
    outputUsdPer1M: 0.79,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    requiresKey: true,
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
  },
  {
    id: 'ollama',
    label: 'Ollama (local, free)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    requiresKey: false,
    inputUsdPer1M: 0,
    outputUsdPer1M: 0,
  },
  {
    id: 'mock',
    label: 'Mock (offline)',
    baseUrl: MOCK_AI_BASE_URL,
    model: MOCK_AI_MODEL,
    requiresKey: false,
    hint: 'Deterministic built-in provider for development and tests: keyword-based grading, simulated OCR and sample questions. Not available in production.',
    // Nominal prices so usage and cost tracking can be exercised end to end.
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
  },
];

/** Why the mock provider is in use: chosen explicitly, or as the dev/test fallback when no API key is configured. */
export type AiMockReason = 'selected' | 'fallback';

export interface AiSettingsDto {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  /** True when an API key is available (stored in DB or from env). */
  hasKey: boolean;
  /** Masked hint such as `AQ….Sf9Q`; the key itself is never returned. */
  keyHint: string | null;
  keySource: 'database' | 'env' | 'none';
  /** Provider and model actually used for AI calls (the mock when the fallback is active). */
  effectiveProvider: AiProviderId;
  effectiveModel: string;
  mockReason: AiMockReason | null;
  /** False in production, where the mock provider can't be used. */
  mockAllowed: boolean;
  /** Effective prices for cost estimates (USD per 1M tokens); null when unknown. */
  inputUsdPer1M: number | null;
  outputUsdPer1M: number | null;
  pricingSource: 'settings' | 'preset' | 'none';
  updatedAt: string | null;
}

export interface AiSettingsUpdate {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  /** Empty/undefined keeps the stored key. */
  apiKey?: string;
  /** Price overrides for cost estimates (USD per 1M tokens); null uses the preset price. Undefined keeps them. */
  inputUsdPer1M?: number | null;
  outputUsdPer1M?: number | null;
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  model?: string;
  message: string;
}

/** Whether AI features can run for an institute right now, and the remaining monthly quota. */
export interface AiAvailabilityDto {
  available: boolean;
  reason: 'MODULE_DISABLED' | 'AI_NOT_CONFIGURED' | 'AI_QUOTA_EXCEEDED' | 'SUBSCRIPTION_INACTIVE' | null;
  provider: AiProviderId;
  model: string;
  mock: boolean;
  tokensUsed: number;
  monthlyLimit: number | null;
  remainingTokens: number | null;
}

export interface AiUsageFeatureRow {
  feature: string;
  requests: number;
  errors: number;
  totalTokens: number;
  images: number;
  estimatedCostUsd: number;
}

/** Institute AI usage for the current month (institute timezone). */
export interface AiUsageSummaryDto extends AiAvailabilityDto {
  /** Start of the metering month (ISO instant). */
  periodStart: string;
  /** @deprecated use `tokensUsed`. */
  tokensThisMonth: number;
  requests: number;
  errors: number;
  images: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  byFeature: AiUsageFeatureRow[];
}

/** Platform-wide usage per institute (`instituteId` null = platform calls such as connection tests). */
export interface AiAdminUsageRow {
  instituteId: number | null;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  images: number;
  estimatedCostUsd: number;
}

export interface AiAdminUsageDto {
  since: string;
  byInstitute: AiAdminUsageRow[];
  byProvider: (Omit<AiAdminUsageRow, 'instituteId'> & { provider: string; model: string })[];
}
