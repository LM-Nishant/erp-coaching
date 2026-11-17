export type AiProviderId = 'openai' | 'azure-openai' | 'gemini' | 'groq' | 'openrouter' | 'ollama' | 'custom';

export interface AiProviderPreset {
  id: AiProviderId;
  label: string;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
  hint?: string;
}

/** Any OpenAI-compatible chat completions API. */
export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresKey: true },
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
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    requiresKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    requiresKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local, free)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    requiresKey: false,
  },
];

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
  updatedAt: string | null;
}

export interface AiSettingsUpdate {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
  /** Empty/undefined keeps the stored key. */
  apiKey?: string;
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  model?: string;
  message: string;
}
