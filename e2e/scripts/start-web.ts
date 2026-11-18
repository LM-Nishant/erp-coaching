/**
 * Starts the web app's Vite dev server for E2E runs, pointed at the E2E API. Used by
 * playwright.config.ts `webServer` and by `npm run serve:web -w @erp/e2e`.
 */
import { spawn } from 'node:child_process';
import { API_URL, REPO_ROOT, WEB_PORT } from '../support/env';

const isWindows = process.platform === 'win32';
const web = spawn(
  isWindows ? 'npm.cmd' : 'npm',
  ['run', 'dev', '-w', 'app', '--', '--port', String(WEB_PORT), '--strictPort'],
  { cwd: REPO_ROOT, env: { ...process.env, VITE_API_URL: API_URL }, stdio: 'inherit', shell: isWindows },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => web.kill(signal));
web.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
