/**
 * Locators for Ionic UI. Ionic keeps previously visited pages in the DOM (hidden) and renders
 * overlays (toasts, alerts, action sheets, modals) outside the page, so scope accordingly.
 */
import { expect, type Locator, type Page } from '@playwright/test';

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
