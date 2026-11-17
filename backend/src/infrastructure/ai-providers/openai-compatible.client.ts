import type { AiProviderId } from '@erp/shared';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}

export interface ProviderConnection {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
}

export class AiProviderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

/** Minimal client for any OpenAI-compatible `/chat/completions` endpoint (OpenAI, Azure v1, Gemini, Groq, OpenRouter, Ollama). */
export async function chatCompletion(conn: ProviderConnection, req: ChatRequest): Promise<ChatResponse> {
  const url = `${conn.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (conn.apiKey) {
    headers.Authorization = `Bearer ${conn.apiKey}`;
    if (conn.provider === 'azure-openai') headers['api-key'] = conn.apiKey;
  }
  const body: Record<string, unknown> = {
    model: conn.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.2,
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.jsonMode) body.response_format = { type: 'json_object' };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(conn.timeoutMs),
    });
  } catch (err) {
    throw new AiProviderError(`Could not reach AI provider: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.[0]?.error?.message ?? detail;
    } catch {
      /* not JSON */
    }
    throw new AiProviderError(`AI provider returned ${res.status}: ${detail}`, res.status);
  }
  const json = JSON.parse(text);
  const usage = json.usage ?? {};
  return {
    content: json.choices?.[0]?.message?.content ?? '',
    model: json.model ?? conn.model,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    },
    latencyMs: Date.now() - started,
  };
}
