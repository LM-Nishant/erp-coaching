import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import { config } from './config';
import { logger } from './logger';
import { getSequelize } from './database/sequelize';
import { createMigrator } from './database/migrator';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  version: string;
  uptimeSeconds: number;
  checks: {
    database: { ok: boolean; latencyMs?: number };
    migrations: { ok: boolean; pending?: number };
    storage: { ok: boolean; driver: string };
  };
}

const startedAt = Date.now();
const MIGRATIONS_TTL_MS = 30_000;
let migrationsCache: { at: number; pending: number } | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkDatabase(): Promise<ReadinessReport['checks']['database']> {
  const t0 = Date.now();
  try {
    await withTimeout(getSequelize().query('SELECT 1'), 3000, 'database ping');
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    logger.warn({ reason: String(err) }, 'readiness: database unavailable');
    return { ok: false };
  }
}

/** A new release must not take traffic before its migrations ran (see docs/deployment.md). */
async function checkMigrations(): Promise<ReadinessReport['checks']['migrations']> {
  if (migrationsCache && migrationsCache.pending === 0 && Date.now() - migrationsCache.at < MIGRATIONS_TTL_MS)
    return { ok: true, pending: 0 };
  try {
    const pending = (await withTimeout(createMigrator(getSequelize()).pending(), 5000, 'migration check'))
      .length;
    migrationsCache = { at: Date.now(), pending };
    return { ok: pending === 0, pending };
  } catch (err) {
    logger.warn({ reason: String(err) }, 'readiness: migration status unavailable');
    return { ok: false };
  }
}

async function checkStorage(): Promise<ReadinessReport['checks']['storage']> {
  if (config.STORAGE_DRIVER !== 'local') return { ok: true, driver: config.STORAGE_DRIVER };
  try {
    await fsp.mkdir(config.storageLocalRoot, { recursive: true });
    await fsp.access(config.storageLocalRoot, constants.W_OK);
    return { ok: true, driver: 'local' };
  } catch (err) {
    logger.warn({ reason: String(err) }, 'readiness: storage not writable');
    return { ok: false, driver: 'local' };
  }
}

/** For load balancers and orchestrators: 200 only when this node can serve requests. */
export async function readiness(): Promise<ReadinessReport> {
  const [database, storage] = await Promise.all([checkDatabase(), checkStorage()]);
  const migrations = database.ok ? await checkMigrations() : { ok: false };
  const ok = database.ok && migrations.ok && storage.ok;
  return {
    status: ok ? 'ready' : 'not_ready',
    version: config.APP_VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    checks: { database, migrations, storage },
  };
}
