/**
 * Signed download links (invoice PDFs, data exports) are opened with `openFileLink`, which calls
 * `window.open` in a browser. Instead of chasing a new tab that turns into a download, the specs
 * record the URL the app opens and fetch it over HTTP, so they can check the file itself. Files the
 * app fetches itself (`api.download`, e.g. report exports) go through `saveFile`, which uses an
 * `<a download>` link in a browser: `savedDownload` captures those.
 */
import { readFile } from 'node:fs/promises';
import { expect, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';

type Trapped = Window & { __e2eOpened?: string[] };

/** Makes `window.open` record its URL instead of opening a tab. Call again after a full page load. */
export async function trapWindowOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Trapped;
    w.__e2eOpened = [];
    window.open = ((url?: string | URL) => {
      w.__e2eOpened!.push(String(url));
      return window;
    }) as typeof window.open;
  });
}

/** Waits for the app to open a URL after `trapWindowOpen`, and returns the latest one. */
export async function openedUrl(page: Page): Promise<string> {
  let url = '';
  await expect
    .poll(async () => (url = await page.evaluate(() => (window as Trapped).__e2eOpened?.at(-1) ?? '')))
    .not.toBe('');
  return url;
}

/** Fetches a signed link anonymously (it needs no session) and checks it is served as a download. */
export async function fetchDownload(http: APIRequestContext, url: string): Promise<APIResponse> {
  const response = await http.get(url, { failOnStatusCode: false });
  expect(response.status(), `GET ${url}`).toBe(200);
  return response;
}

/**
 * Runs `trigger`, which makes the app fetch a file from a URL matching `url` and save it, and
 * returns the API response (for its headers) and the file the browser saved.
 */
export async function savedDownload(
  page: Page,
  url: RegExp,
  trigger: () => Promise<unknown>,
): Promise<{ response: Response; fileName: string; text: string }> {
  const [response, download] = await Promise.all([
    page.waitForResponse((r) => url.test(r.url()) && r.request().method() === 'GET'),
    page.waitForEvent('download'),
    trigger(),
  ]);
  expect(response.status(), `GET ${response.url()}`).toBe(200);
  return {
    response,
    fileName: download.suggestedFilename(),
    text: await readFile(await download.path(), 'utf8'),
  };
}
