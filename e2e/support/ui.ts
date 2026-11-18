/**
 * Locators for Ionic UI. Ionic keeps previously visited pages in the DOM (hidden) and renders
 * overlays (toasts, alerts, action sheets, modals) outside the page, so scope accordingly.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { outboxMark, waitForOtp } from './outbox';

/** The page currently shown by the app's router outlet. */
export function activePage(page: Page): Locator {
  return page.locator('ion-router-outlet#main > .ion-page:not(.ion-page-hidden)').last();
}

/** The topmost open modal. */
export function modal(page: Page): Locator {
  return page.locator('ion-modal:not(.overlay-hidden)').last();
}

export function alertDialog(page: Page): Locator {
  return page.locator('ion-alert:not(.overlay-hidden)').last();
}

export function actionSheet(page: Page): Locator {
  return page.locator('ion-action-sheet:not(.overlay-hidden)').last();
}

/**
 * Selects an ion-segment option. Its accessible `tab` is a shadow button with pointer-events: none
 * (the host handles the click), so click the host element instead.
 */
export async function selectSegment(scope: Page | Locator, label: string): Promise<void> {
  const option = scope.locator('ion-segment-button').filter({ hasText: label });
  await option.click();
  await expect(option.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
}

export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('ion-toast').filter({ hasText: text }).last()).toBeVisible();
}

/** Confirms an ion-alert (e.g. "Close attendance?") with the given button. */
export async function confirmAlert(page: Page, button: string): Promise<void> {
  const alert = alertDialog(page);
  await alert.getByRole('button', { name: button, exact: true }).click();
  await expect(alert).toBeHidden();
}

/**
 * Opens an `ion-select` with `interface="popover"` and picks an option by its label. Pass the
 * select itself, e.g. `page.locator('ion-select').filter({ hasText: 'Teacher' })`.
 */
export async function chooseOption(select: Locator, option: string | RegExp): Promise<void> {
  await select.click();
  const popover = select.page().locator('ion-popover:not(.overlay-hidden)').last();
  await popover.getByRole('radio', { name: option }).click();
  await expect(popover).toBeHidden();
}

/**
 * Signs in on the login page with a mobile OTP (read from the outbox), as a user would on a
 * phone. Use it on a page that is at /login (e.g. after being redirected there from a deep link);
 * it resolves once the app has navigated away from /login.
 */
export async function signInWithOtp(page: Page, mobile: string): Promise<void> {
  await selectSegment(page, 'Mobile OTP');
  await page.getByLabel('Mobile number').fill(mobile);
  const since = outboxMark();
  await page.getByRole('button', { name: 'Send OTP' }).click();
  await expect(page.getByText('Enter the 6-digit code sent to')).toBeVisible();
  await page.getByLabel('OTP').fill(await waitForOtp(mobile, since));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
