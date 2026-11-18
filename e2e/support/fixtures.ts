/**
 * Playwright fixtures for the workflow specs:
 * - `http`: an APIRequestContext for setup calls (see Api/Session in ./api).
 * - `superAdmin`: the seeded platform admin, signed in for each test (creates the institutes). Always
 *   the same device, so it never needs an OTP or uses up the device limit.
 * - `openAs(session, path)`: a new browser context already signed in as `session` (same device as the
 *   API login, injected the way the app stores it), or anonymous with `null`.
 */
import {
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import { loginWithPassword, type Session } from './api';
import { SUPER_ADMIN, WEB_URL } from './env';

/** localStorage as the app persists it on web: Capacitor Device uid + Preferences `erp.session`. */
export function signedInState(session: Session): BrowserContextOptions['storageState'] {
  return {
    cookies: [],
    origins: [
      {
        origin: WEB_URL,
        localStorage: [
          { name: '_capuid', value: session.device.uid },
          {
            name: 'CapacitorStorage.erp.session',
            value: JSON.stringify({
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
              branchId: null,
            }),
          },
        ],
      },
    ],
  };
}

type TestFixtures = {
  superAdmin: Session;
  openAs: (session: Session | null, path?: string) => Promise<Page>;
};
type WorkerFixtures = {
  http: APIRequestContext;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  http: [
    async ({ playwright }, use) => {
      const http = await playwright.request.newContext();
      await use(http);
      await http.dispose();
    },
    { scope: 'worker' },
  ],
  // Test-scoped: access tokens are short-lived (15 min), which a long run would outlast.
  superAdmin: async ({ http }, use) => {
    await use(
      await loginWithPassword(http, SUPER_ADMIN, {
        uid: 'e2e-super-admin-device',
        name: 'E2E super admin',
        platform: 'web',
      }),
    );
  },
  openAs: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (session, path = '/home') => {
      const context = await browser.newContext(session ? { storageState: signedInState(session) } : {});
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(path);
      return page;
    });
    for (const context of contexts) await context.close();
  },
});

export { expect } from '@playwright/test';
