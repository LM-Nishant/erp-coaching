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

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://localhost:8100,capacitor://localhost,http://localhost,https://localhost',
    ),
  LOG_LEVEL: z.string().default(isProd ? 'info' : 'debug'),

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

  STORAGE_DRIVER: z.enum(['local', 's3', 'r2']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().default(100),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().default(300),

  AI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_API_KEY: z.string().default(''),
  AI_TIMEOUT_MS: z.coerce.number().default(60000),

  SMS_PROVIDER: z.enum(['console']).default('console'),
  WHATSAPP_PROVIDER: z.enum(['console']).default('console'),
  EMAIL_PROVIDER: z.enum(['console']).default('console'),
  PUSH_PROVIDER: z.enum(['console']).default('console'),
  PAYMENT_GATEWAY: z.enum(['mock']).default('mock'),
  STREAMING_PROVIDER: z.enum(['mock']).default('mock'),
  BIOMETRIC_PROVIDER: z.enum(['mock']).default('mock'),

  JOBS_WORKER_ENABLED: bool(true),
  /** Express `trust proxy` setting (number of hops), needed behind nginx for correct client IPs. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  JOBS_POLL_INTERVAL_MS: z.coerce.number().default(2000),
  RATE_LIMIT_ENABLED: bool(true),

  SEED_SUPERADMIN_MOBILE: z.string().default('9000000000'),
  SEED_SUPERADMIN_PASSWORD: z.string().default('Admin@12345'),
  SEED_DEMO_PASSWORD: z.string().default('Password@123'),
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

export const config = {
  ...parsed.data,
  isProd,
  isTest: parsed.data.NODE_ENV === 'test',
  storageLocalRoot: path.resolve(__dirname, '../../..', parsed.data.STORAGE_LOCAL_ROOT),
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export type AppConfig = typeof config;
