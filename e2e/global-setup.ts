/**
 * Runs after the web servers are up (Playwright starts `webServer` before globalSetup): checks the
 * API and warms up the Vite dev server so the first spec doesn't pay for dependency optimisation
 * and on-demand compilation of the app.
 */
import { chromium, expect, request } from '@playwright/test';
import { API_URL, WEB_URL } from './support/env';

export default async function globalSetup(): Promise<void> {
  const http = await request.newContext();
  try {
    const health = await http.get(`${API_URL}/api/health`);
    if (!health.ok()) throw new Error(`API health check failed: ${health.status()} ${await health.text()}`);
  } finally {
    await http.dispose();
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${WEB_URL}/login`, { timeout: 120_000 });
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 120_000 });
  } finally {
    await browser.close();
  }
}
