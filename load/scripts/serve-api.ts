/**
 * Starts a local API for load testing on LOAD_API_URL's port (4105 by default) against its own
 * database: LOAD_DB_NAME, else `${TEST_DB_NAME}_load` (from the environment or backend/.env). The
 * database is reset first (all tables dropped, migrated, seeded); LOAD_KEEP_DB=true keeps the data
 * and only applies pending migrations and seeders.
 *
 * Rate limits are switched off (they would turn the run into a 429 benchmark), messages go to
 * load/.tmp/outbox.jsonl (where the runner reads new-device OTPs) and uploads to load/.tmp/storage.
 * The server runs without watch mode; LOG_LEVEL is `warn` unless LOAD_API_LOG_LEVEL says otherwise.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { API_URL, REPO_ROOT, TMP_DIR, readBackendDotenv, settings } from '../src/env';

const url = new URL(API_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error(`serve:api only starts a local API; LOAD_API_URL is ${API_URL}`);
const port = url.port || '80';

function resolveDbName(): string {
  const explicit = process.env.LOAD_DB_NAME?.trim();
  const testDb = process.env.TEST_DB_NAME?.trim() || readBackendDotenv().TEST_DB_NAME?.trim();
  const name = explicit || (testDb ? `${testDb}_load` : 'erp_coaching_test_load');
  // The reset drops every table in this database, so be strict about what it may be.
  if (!/^[A-Za-z0-9_]+$/.test(name) || !name.toLowerCase().includes('load'))
    throw new Error(
      `Refusing to use database "${name}" for load tests: the name must contain "load" and only [A-Za-z0-9_].`,
    );
  return name;
}

const DB_NAME = resolveDbName();
const STORAGE_DIR = path.join(TMP_DIR, 'storage');
const keepDb = process.env.LOAD_KEEP_DB === 'true';

/**
 * Settings left at the backend's defaults: the backend's dotenv never overrides a variable that is
 * already set (even to ''), and it treats blank as unset, so a developer's backend/.env cannot skew
 * the numbers. DB_HOST/DB_PORT/DB_USER/DB_PASSWORD still come from the environment or backend/.env.
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
  'ENCRYPTION_PREVIOUS_KEYS',
  'FILE_URL_SECRET',
  'OTP_HASH_SECRET',
  'PASSWORD_HASH_COST',
  'OTP_TTL_SECONDS',
  'OTP_MAX_ATTEMPTS',
  'OTP_REQUESTS_PER_MOBILE',
  'LOGIN_LOCKOUT_THRESHOLD',
  'LOGIN_LOCKOUT_BASE_SECONDS',
  'LOGIN_LOCKOUT_MAX_SECONDS',
  'REDIS_URL',
  'MAX_UPLOAD_MB',
  'MAX_ACTIVE_DEVICES',
  'SIGNED_URL_TTL_SECONDS',
  'AI_BASE_URL',
  'AI_MODEL',
  // No key: AI features stay off and nothing calls a third-party service.
  'AI_API_KEY',
  'AI_TIMEOUT_MS',
  'SEED_DEMO_PASSWORD',
  'JOBS_POLL_INTERVAL_MS',
] as const;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries(BACKEND_DEFAULTS.map((key) => [key, ''])),
  NODE_ENV: 'development',
  PORT: port,
  DB_NAME,
  DB_LOGGING: 'false',
  API_PUBLIC_URL: API_URL,
  LOG_LEVEL: process.env.LOAD_API_LOG_LEVEL || 'warn',
  RATE_LIMIT_ENABLED: 'false',
  JOBS_WORKER_ENABLED: 'true',
  SMS_PROVIDER: 'console',
  WHATSAPP_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  PUSH_PROVIDER: 'console',
  PAYMENT_GATEWAY: 'mock',
  STREAMING_PROVIDER: 'mock',
  BIOMETRIC_PROVIDER: 'mock',
  DEV_OUTBOX_FILE: settings.outboxFile,
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_ROOT: STORAGE_DIR,
  SEED_SUPERADMIN_MOBILE: settings.superAdmin.mobile,
  SEED_SUPERADMIN_PASSWORD: settings.superAdmin.password,
  SEED_DEMO_DATA: 'true',
};

const tsx = require.resolve('tsx/cli');
if (!keepDb) fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });

for (const command of keepDb ? ['create', 'migrate', 'seed'] : ['create', 'reset']) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [tsx, 'backend/src/infrastructure/database/cli.ts', command], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    console.error(
      `[load] database ${command} failed for ${DB_NAME} (exit ${result.status ?? result.signal})`,
    );
    process.exit(1);
  }
  console.log(`[load] database ${command} ${DB_NAME}: ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

console.log(`[load] starting API on ${API_URL} (rate limits off, outbox: ${settings.outboxFile})`);
const server = spawn(process.execPath, [tsx, 'backend/src/server.ts'], {
  cwd: REPO_ROOT,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
