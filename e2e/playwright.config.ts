import { defineConfig, devices } from '@playwright/test';
import { API_URL, WEB_URL, isCI } from './support/env';

/**
 * Browser E2E suite for the critical workflows (spec section 7). See e2e/README.md.
 *
 * Playwright starts the web servers before globalSetup, so the database reset happens inside the
 * API server command (scripts/start-api.ts): every run starts from a freshly seeded database.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  // Specs share one API and database, and some assert on the shared outbox: run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 120_000,
  // A whole run takes a few minutes; stop a hung CI job long before the runner's own limit.
  globalTimeout: isCI ? 20 * 60_000 : undefined,
  expect: { timeout: 15_000 },
  reporter: [
    ...(isCI ? [['github'] as const] : []),
    ['list'],
    ['html', { outputFolder: './playwright-report', open: 'never' }],
  ],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: WEB_URL,
    // Institutes default to Asia/Kolkata; keep the browser in the same zone as "today" on the server.
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'api',
      command: 'npx tsx scripts/start-api.ts',
      url: `${API_URL}/api/health`,
      timeout: 240_000,
      reuseExistingServer: !isCI,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    {
      name: 'web',
      command: 'npx tsx scripts/start-web.ts',
      url: WEB_URL,
      timeout: 180_000,
      reuseExistingServer: !isCI,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
