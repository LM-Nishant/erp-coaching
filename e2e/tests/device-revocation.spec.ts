/**
 * Admin device revocation (final wave #17): an institute admin signs a teacher's device out from
 * "Member devices"; the teacher's open app on that device is sent back to sign-in with the reason.
 *
 * Setup (API): a new institute and a teacher with a password, signed in on one web device. Browser:
 * the teacher has the app open. The admin searches for the teacher on "Member devices", opens their
 * devices and signs the device out (confirming the alert). The device row then reads "Signed out";
 * the teacher's next request is refused (401 SESSION_REVOKED), and their app shows the sign-in page
 * with "This device was signed out of your account."
 */
import { expect, test } from '../support/fixtures';
import { ApiError, loginWithPassword, newDevice } from '../support/api';
import { addStaff, createInstitute } from '../support/data';
import { activePage, alertDialog, confirmAlert, expectToast, modal } from '../support/ui';

test('admin signs out a teacher device → the teacher is signed out with the reason', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'devices');
  const teacher = await addStaff(institute, 'teacher', 'Tara Teacher');
  const session = await loginWithPassword(http, teacher, newDevice('teacher-laptop'));

  const teacherPage = await test.step('teacher has the app open', async () => {
    const page = await openAs(session, '/home');
    await expect(page).toHaveURL(/\/home$/);
    return page;
  });

  await test.step('admin signs the teacher device out from "Member devices"', async () => {
    const page = await openAs(institute.admin, '/users/devices');
    const content = activePage(page);
    await content.getByPlaceholder('Name, mobile or email').fill(teacher.mobile);
    const member = content.locator('ion-item').filter({ hasText: teacher.name });
    await expect(member).toContainText('1 signed in');
    await member.click();

    const devices = modal(page);
    await expect(devices.locator('ion-title')).toHaveText(teacher.name);
    const device = devices.locator('ion-item').filter({ hasText: session.device.name });
    await expect(device).toContainText('Signed in · last seen');
    await device.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(alertDialog(page)).toContainText('Sign out this device?');
    await confirmAlert(page, 'Sign out');
    await expectToast(page, 'Device signed out');
    await expect(device).toContainText('Signed out');
    await expect(device.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  });

  await test.step('the revoked session is refused by the API', async () => {
    const refused = await session.api.get('/auth/me').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(401);
    expect((refused as ApiError).body).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
  });

  await test.step('the teacher app returns to sign-in with the reason', async () => {
    await teacherPage.reload();
    await expect(teacherPage).toHaveURL(/\/login/);
    await expect(
      teacherPage.getByText('This device was signed out of your account. Sign in again to continue.'),
    ).toBeVisible();
  });
});
