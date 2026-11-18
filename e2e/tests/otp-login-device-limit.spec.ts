/**
 * Spec §7 — OTP login and the device limit.
 *
 * A staff member signs in with a mobile OTP on a first browser, with password + new-device OTP on a
 * second browser, and is then refused on a third browser (password and OTP) because the account is
 * already active on MAX_ACTIVE_DEVICES (2) devices. Signing one device out from "My devices" frees a
 * slot for the third browser. Every Playwright browser context is a new device for the app.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { addStaff, createInstitute, type Person } from '../support/data';
import { MAX_ACTIVE_DEVICES } from '../support/env';
import { outboxMark, waitForOtp } from '../support/outbox';
import { activePage, confirmAlert, expectToast, selectSegment } from '../support/ui';

const LOGIN_LIMIT_MESSAGE =
  'You are already signed in on the maximum number of devices. Sign out of one in "My devices" on another device, or ask your institute admin to remove an old device.';
const VERIFY_LIMIT_MESSAGE = 'Device limit reached. Ask your institute admin to remove an old device.';

async function requestOtpLogin(page: Page, user: Person): Promise<number> {
  await selectSegment(page, 'Mobile OTP');
  await page.getByLabel('Mobile number').fill(user.mobile);
  const since = outboxMark();
  await page.getByRole('button', { name: 'Send OTP' }).click();
  await expect(page.getByText('Enter the 6-digit code sent to')).toBeVisible();
  return since;
}

async function submitPassword(page: Page, user: Person): Promise<void> {
  await page.getByLabel('Mobile or email').fill(user.mobile);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function enterOtp(page: Page, user: Person, since: number): Promise<void> {
  await page.getByLabel('OTP').fill(await waitForOtp(user.mobile, since));
  await page.getByRole('button', { name: 'Verify' }).click();
}

async function expectHome(page: Page, user: Person): Promise<void> {
  await expect(page).toHaveURL(/\/home$/);
  await expect(activePage(page).getByRole('heading', { name: `Hello, ${user.name}` })).toBeVisible();
}

test('OTP login, then the device limit blocks a third device until one is signed out', async ({
  http,
  superAdmin,
  openAs,
}) => {
  expect(MAX_ACTIVE_DEVICES).toBe(2);
  const institute = await createInstitute(http, superAdmin, 'auth');
  const user = await addStaff(institute, 'teacher', 'Tara Teacher');

  await test.step('device 1: sign in with a mobile OTP', async () => {
    const page = await openAs(null, '/login');
    const since = await requestOtpLogin(page, user);
    await expect(page.getByText('This is a new device.')).toBeHidden();
    await enterOtp(page, user, since);
    await expectHome(page, user);
  });

  const second = await test.step('device 2: password sign-in asks for a new-device OTP', async () => {
    const page = await openAs(null, '/login');
    const since = outboxMark();
    await submitPassword(page, user);
    await expect(page.getByText('This is a new device.')).toBeVisible();
    await enterOtp(page, user, since);
    await expectHome(page, user);
    return page;
  });

  const third = await openAs(null, '/login');
  await test.step('device 3: refused at password sign-in', async () => {
    await submitPassword(third, user);
    await expect(third.getByText(LOGIN_LIMIT_MESSAGE)).toBeVisible();
    await expect(third).toHaveURL(/\/login/);
  });

  await test.step('device 3: refused after a correct mobile OTP', async () => {
    const since = await requestOtpLogin(third, user);
    await enterOtp(third, user, since);
    await expect(third.getByText(VERIFY_LIMIT_MESSAGE)).toBeVisible();
    await expect(third).not.toHaveURL(/\/home/);
  });

  await test.step('device 2 signs out the other device from "My devices"', async () => {
    await second.goto('/account/devices');
    const devices = activePage(second);
    await expect(devices.getByText('This device')).toBeVisible();
    await expect(devices.locator('ion-item')).toHaveCount(MAX_ACTIVE_DEVICES);
    await devices.getByRole('button', { name: 'Sign out' }).click();
    await confirmAlert(second, 'Sign out');
    await expectToast(second, 'Device signed out');
    await expect(devices.getByText(/^Signed out · last seen/)).toBeVisible();
  });

  await test.step('device 3 can now sign in (password + new-device OTP)', async () => {
    await third.goto('/login');
    const since = outboxMark();
    await submitPassword(third, user);
    await expect(third.getByText('This is a new device.')).toBeVisible();
    await enterOtp(third, user, since);
    await expectHome(third, user);
  });
});
