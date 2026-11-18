/**
 * Starts the API for an E2E run: wipes e2e/.tmp (outbox, uploads), creates and resets the E2E
 * database (drop all tables, migrate, seed), then runs the server without watch mode.
 *
 * Playwright's `webServer` runs this before any test (and before globalSetup), so every run starts
 * from a freshly seeded database. Run it yourself (`npm run serve:api -w @erp/e2e`) to keep a
 * server up while iterating on a spec; Playwright then reuses it (locally, not on CI).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { API_URL, DB_NAME, OUTBOX_FILE, REPO_ROOT, STORAGE_DIR, TMP_DIR, apiServerEnv } from '../support/env';

const env = { ...process.env, ...apiServerEnv() };
const tsx = require.resolve('tsx/cli');

fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });

for (const command of ['create', 'reset']) {
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
    console.error(`[e2e] database ${command} failed for ${DB_NAME} (exit ${result.status ?? result.signal})`);
    process.exit(1);
  }
  console.log(`[e2e] database ${command} ${DB_NAME}: ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

console.log(`[e2e] starting API on ${API_URL} (outbox: ${OUTBOX_FILE})`);
const server = spawn(process.execPath, [tsx, 'backend/src/server.ts'], {
  cwd: REPO_ROOT,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
