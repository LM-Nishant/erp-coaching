import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const isProd = process.env.NODE_ENV === 'production';
const devDefault = (value: string) => (isProd ? z.string().min(16) : z.string().min(1).default(value));
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

export const DEFAULT_SUPERADMIN_PASSWORD = 'Admin@12345';
export const DEFAULT_DEMO_PASSWORD = 'Password@123';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://localhost:8100,capacitor://localhost,http://localhost,https://localhost',
    ),
  /**
   * Public origin of the web app (no trailing slash). Links into the app (website "Register"/"Buy"
   * buttons, course checkout) start here. Required in production; elsewhere it falls back to the first
   * http(s) `CORS_ORIGINS` entry.
   */
  PUBLIC_WEB_URL: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//.test(v), 'must be an http(s) URL')
    .optional(),
  LOG_LEVEL: z.string().default(isProd ? 'info' : 'debug'),
  /** Reported by /api/ready and attached to tracked errors (e.g. the git SHA or image tag). */
  APP_VERSION: z.string().default('dev'),
  /** Optional error tracking adapter: `log` writes a structured `error_tracking` entry. */
  ERROR_TRACKING_PROVIDER: z.enum(['none', 'log', 'webhook']).default('none'),
  /** For `webhook`: JSON events are POSTed here (your collector or a vendor's ingest proxy). */
  ERROR_TRACKING_WEBHOOK_URL: z.string().url().optional(),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(3306),
  DB_NAME: z.string().default('erp_coaching'),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_LOGGING: bool(false),

  JWT_ACCESS_SECRET: devDefault('dev-only-access-secret-change-me'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  IMPERSONATION_TTL_SECONDS: z.coerce.number().default(1800),
  /** 32 bytes, base64 encoded. Used for AES-256-GCM encryption of secrets at rest. */
  ENCRYPTION_KEY: devDefault('ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzItYnl0ZXM='),
  FILE_URL_SECRET: devDefault('dev-only-file-url-secret-change-me'),

  OTP_TTL_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  MAX_ACTIVE_DEVICES: z.coerce.number().default(2),
  /** Default inactivity timeout (minutes, 0 = off) for sessions without an institute setting. */
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(0).max(1440).default(0),

  STORAGE_DRIVER: z.enum(['local', 's3', 'r2']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().default(100),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().default(300),

  AI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_API_KEY: z.string().default(''),
  AI_TIMEOUT_MS: z.coerce.number().default(60000),
  // Dev/test only: use the built-in mock provider while no API key is configured. Ignored in production.
  AI_MOCK_FALLBACK: bool(true),

  SMS_PROVIDER: z.enum(['console']).default('console'),
  WHATSAPP_PROVIDER: z.enum(['console']).default('console'),
  EMAIL_PROVIDER: z.enum(['console']).default('console'),
  PUSH_PROVIDER: z.enum(['console']).default('console'),
  PAYMENT_GATEWAY: z.enum(['mock']).default('mock'),
  /** Minutes between gateway status checks of open online payments and refunds (missed webhooks). */
  PAYMENT_RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  STREAMING_PROVIDER: z.enum(['mock']).default('mock'),
  BIOMETRIC_PROVIDER: z.enum(['mock']).default('mock'),

  JOBS_WORKER_ENABLED: bool(true),
  /** Express `trust proxy` setting (number of hops), needed behind nginx for correct client IPs. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  JOBS_POLL_INTERVAL_MS: z.coerce.number().default(2000),
  RATE_LIMIT_ENABLED: bool(true),
  /** Per client IP. Clients behind one NAT (an institute's Wi-Fi) share these budgets. */
  RATE_LIMIT_API_PER_MIN: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_MEDIA_PER_MIN: z.coerce.number().int().positive().default(3000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_TOKEN_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_PUBLIC_FORM_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_DEVICE_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WEBHOOK_PER_MIN: z.coerce.number().int().positive().default(300),

  SEED_SUPERADMIN_MOBILE: z.string().default('9000000000'),
  /** Production seeding refuses the default; see docs/deployment.md. */
  SEED_SUPERADMIN_PASSWORD: z.string().default(DEFAULT_SUPERADMIN_PASSWORD),
  /** Demo institutes and users (README). Off by default in production. */
  SEED_DEMO_DATA: bool(!isProd),
  SEED_DEMO_PASSWORD: z.string().default(DEFAULT_DEMO_PASSWORD),

  /** Dev/test only: also append every console-provider message (OTPs…) to this JSONL file. */
  DEV_OUTBOX_FILE: z.string().optional(),
});

// Blank values (`KEY=`) count as unset so defaults apply.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''),
);
const parsed = schema.safeParse(env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.issues);
  throw new Error('Invalid environment configuration');
}
if (isProd && parsed.data.DEV_OUTBOX_FILE) throw new Error('DEV_OUTBOX_FILE must not be set in production');
if (parsed.data.ERROR_TRACKING_PROVIDER === 'webhook' && !parsed.data.ERROR_TRACKING_WEBHOOK_URL)
  throw new Error('ERROR_TRACKING_WEBHOOK_URL is required when ERROR_TRACKING_PROVIDER=webhook');

const corsOrigins = parsed.data.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (isProd && !parsed.data.PUBLIC_WEB_URL)
  throw new Error('PUBLIC_WEB_URL is required in production (the public origin of the web app)');
const fallbackWebUrl = corsOrigins.find((o) => /^https?:\/\//.test(o)) ?? 'http://localhost:5173';
if (!parsed.data.PUBLIC_WEB_URL && parsed.data.NODE_ENV === 'development')
  console.warn(`PUBLIC_WEB_URL is not set; links into the web app use ${fallbackWebUrl}`);

export const config = {
  ...parsed.data,
  isProd,
  isTest: parsed.data.NODE_ENV === 'test',
  storageLocalRoot: path.resolve(__dirname, '../../..', parsed.data.STORAGE_LOCAL_ROOT),
  devOutboxFile: parsed.data.DEV_OUTBOX_FILE
    ? path.resolve(__dirname, '../../..', parsed.data.DEV_OUTBOX_FILE)
    : null,
  corsOrigins,
  publicWebUrl: (parsed.data.PUBLIC_WEB_URL ?? fallbackWebUrl).replace(/\/+$/, ''),
};

export type AppConfig = typeof config;
