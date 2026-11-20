/**
 * Roles & permissions: an institute admin creates a custom role, gives it to a new staff member and
 * the member's menu follows the role's permissions.
 *
 * Setup (API): a new institute. Browser (admin): on "Roles & permissions" the admin creates "Front
 * desk" with "View students" ticked (Institute Admin only permissions are shown locked with their
 * note), then adds a staff member holding it under "Staff access". Browser (member): the menu shows
 * Students but not Fees. The admin then ticks "View fees" on the role; after a reload the member's
 * menu shows Fees too. Deleting the role is refused while the member holds it.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { PASSWORD, createInstitute, uniqueMobile } from '../support/data';
import { activePage, alertDialog, chooseOption, expectToast, modal, selectSegment } from '../support/ui';

/** Menu entries by exact title ("Fees", not "My fees"). */
const menuItem = (page: Page, title: string) =>
  page.locator('ion-menu ion-list ion-item ion-label').filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) });

async function openRole(page: Page, name: string) {
  await activePage(page).locator('ion-item').filter({ hasText: name }).click();
  await expect(modal(page).locator('ion-title')).toHaveText('Edit role');
}

test('admin creates a role, assigns it and the member’s menu follows its permissions', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'roles');
  const member = { name: 'Fiona Frontdesk', mobile: uniqueMobile(), password: PASSWORD };
  const admin = await openAs(institute.admin, '/roles');
  const content = activePage(admin);

  await test.step('admin creates "Front desk" with View students', async () => {
    await expect(content.locator('ion-item').filter({ hasText: 'Institute Admin' })).toContainText(
      '1 member',
    );
    await content.getByRole('button', { name: 'Create role' }).click();
    const dialog = modal(admin);
    await expect(dialog.locator('ion-title')).toHaveText('Create role');
    await dialog.getByLabel('Role name').fill('Front desk');
    await dialog.getByLabel('Description').fill('Reception: enquiries and student look-ups');
    const locked = dialog.locator('section.locked').filter({ hasText: 'Institute Admin only' });
    await expect(locked).toContainText('Only the Institute Admin role holds these; other roles cannot.');
    await expect(locked.getByRole('checkbox')).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: /^View students —/ }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(admin, 'Front desk created');
    await expect(dialog).toBeHidden();
    await expect(content.locator('ion-item').filter({ hasText: 'Front desk' })).toContainText('0 members');
  });

  await test.step('admin adds a staff member holding the role', async () => {
    await selectSegment(content, 'Staff access');
    await content.getByRole('button', { name: 'Add staff' }).click();
    const dialog = modal(admin);
    await expect(dialog.locator('ion-title')).toHaveText('Add staff member');
    await dialog.getByLabel('Name').fill(member.name);
    await dialog.getByLabel('Mobile').fill(member.mobile);
    await dialog.getByLabel('Password (optional)').fill(member.password);
    await chooseOption(dialog.locator('ion-select.role-select'), 'Front desk');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(admin, `${member.name} added`);
    await expect(content.locator('ion-item').filter({ hasText: member.name })).toContainText('Front desk');
  });

  const session = await loginWithPassword(http, member, newDevice('front-desk'));
  const memberPage = await openAs(session, '/home');

  await test.step('the member sees Students but not Fees', async () => {
    await expect(menuItem(memberPage, 'Students')).toBeVisible();
    await expect(menuItem(memberPage, 'Fees')).toHaveCount(0);
    await expect(menuItem(memberPage, 'Roles & permissions')).toHaveCount(0);
  });

  await test.step('admin adds View fees to the role', async () => {
    await selectSegment(content, 'Roles');
    await expect(content.locator('ion-item').filter({ hasText: 'Front desk' })).toContainText('1 member');
    await openRole(admin, 'Front desk');
    const dialog = modal(admin);
    await expect(dialog.getByRole('checkbox', { name: /^View students —/ })).toBeChecked();
    await dialog.getByRole('checkbox', { name: /^View fees —/ }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(admin, 'Front desk saved');
  });

  await test.step('the member’s menu now shows Fees', async () => {
    await memberPage.reload();
    await expect(menuItem(memberPage, 'Fees')).toBeVisible();
  });

  await test.step('the role cannot be deleted while held', async () => {
    await openRole(admin, 'Front desk');
    await modal(admin).getByRole('button', { name: 'Delete role' }).click();
    await expect(alertDialog(admin)).toContainText('Front desk is in use');
    await expect(alertDialog(admin)).toContainText('1 staff member holds this role.');
  });
});
