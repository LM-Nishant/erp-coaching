/**
 * Single source of truth for E2E settings. Imported by the Playwright config, the server start
 * scripts and the tests, so everything agrees on ports, URLs, the database and the outbox file.
 */
import fs from 'node:fs';
import path from 'node:path';

export const E2E_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(E2E_DIR, '..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
/** Scratch space for one run (wiped by the API start script): message outbox and uploaded files. */
export const TMP_DIR = path.join(E2E_DIR, '.tmp');
export const OUTBOX_FILE = path.join(TMP_DIR, 'outbox.jsonl');
export const STORAGE_DIR = path.join(TMP_DIR, 'storage');

export const isCI = !!process.env.CI;

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error(`${name} must be a port number`);
  return value;
}

export const API_PORT = port('E2E_API_PORT', 4105);
export const WEB_PORT = port('E2E_WEB_PORT', 5205);
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Minimal reader for backend/.env (the backend itself loads it with dotenv; real env vars win). */
function readBackendDotenv(): Record<string, string> {
  const file = path.join(BACKEND_DIR, '.env');
  if (!fs.existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[2];
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    values[match[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '');
  }
  return values;
}

function resolveDbName(): string {
  const explicit = process.env.E2E_DB_NAME?.trim();
  const testDb = process.env.TEST_DB_NAME?.trim() || readBackendDotenv().TEST_DB_NAME?.trim();
  const name = explicit || (testDb ? `${testDb}_e2e` : 'erp_coaching_test_e2e');
  // The API start script drops every table in this database, so be strict about what it may be.
  if (!/^[A-Za-z0-9_]+$/.test(name) || !name.toLowerCase().includes('e2e'))
    throw new Error(
      `Refusing to use database "${name}" for E2E: the name must contain "e2e" and only [A-Za-z0-9_].`,
    );
  return name;
}

export const DB_NAME = resolveDbName();

/** Seeded by the database reset (passed explicitly so a custom backend/.env can't change it). */
export const SUPER_ADMIN = { mobile: '9000000000', password: 'Admin@12345' } as const;
export const MAX_ACTIVE_DEVICES = 2;

/**
 * Backend settings that fall back to the backend's own defaults. The backend loads backend/.env
 * with dotenv, which never overrides a variable that is already set (even to ''), and it treats
 * blank values as unset. Passing '' therefore shields the run from a developer's .env, so local
 * runs behave like CI (where there is no .env). Only DB_HOST/DB_PORT/DB_USER/DB_PASSWORD come from
 * the environment or backend/.env.
 */
const BACKEND_DEFAULTS = [
  'APP_VERSION',
  'ERROR_TRACKING_PROVIDER',
  'ERROR_TRACKING_WEBHOOK_URL',
  'TRUST_PROXY',
  'JWT_ACCESS_SECRET',
  'ACCESS_TOKEN_TTL_SECONDS',
  'REFRESH_TOKEN_TTL_DAYS',
  'IMPERSONATION_TTL_SECONDS',
  'ENCRYPTION_KEY',
  'FILE_URL_SECRET',
  'OTP_TTL_SECONDS',
  'OTP_MAX_ATTEMPTS',
  'MAX_UPLOAD_MB',
  'SIGNED_URL_TTL_SECONDS',
  'AI_BASE_URL',
  'AI_MODEL',
  // No key: AI features stay off and nothing calls a third-party service.
  'AI_API_KEY',
  'AI_TIMEOUT_MS',
  'RATE_LIMIT_API_PER_MIN',
  'RATE_LIMIT_MEDIA_PER_MIN',
  'RATE_LIMIT_AUTH_MAX',
  'RATE_LIMIT_TOKEN_MAX',
  'RATE_LIMIT_PUBLIC_FORM_MAX',
  'RATE_LIMIT_DEVICE_PER_MIN',
  'RATE_LIMIT_WEBHOOK_PER_MIN',
  'SEED_DEMO_DATA',
  'SEED_DEMO_PASSWORD',
] as const;

/** Environment for the API process (and the database reset that precedes it). */
export function apiServerEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(BACKEND_DEFAULTS.map((key) => [key, ''])),
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    DB_NAME,
    DB_LOGGING: 'false',
    API_PUBLIC_URL: API_URL,
    CORS_ORIGINS: WEB_URL,
    LOG_LEVEL: process.env.E2E_API_LOG_LEVEL || 'warn',
    JOBS_WORKER_ENABLED: 'true',
    JOBS_POLL_INTERVAL_MS: '500',
    RATE_LIMIT_ENABLED: 'false',
    MAX_ACTIVE_DEVICES: String(MAX_ACTIVE_DEVICES),
    // Dev/test providers: messages go to the console and DEV_OUTBOX_FILE, payments to the mock gateway.
    SMS_PROVIDER: 'console',
    WHATSAPP_PROVIDER: 'console',
    EMAIL_PROVIDER: 'console',
    PUSH_PROVIDER: 'console',
    PAYMENT_GATEWAY: 'mock',
    STREAMING_PROVIDER: 'mock',
    BIOMETRIC_PROVIDER: 'mock',
    DEV_OUTBOX_FILE: OUTBOX_FILE,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: STORAGE_DIR,
    SEED_SUPERADMIN_MOBILE: SUPER_ADMIN.mobile,
    SEED_SUPERADMIN_PASSWORD: SUPER_ADMIN.password,
  };
}
