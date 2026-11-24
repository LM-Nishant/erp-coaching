/**
 * Siblings on a parent's mobile: every child has an account of their own (docs/security.md, "Sign-in").
 *
 * Setup (API): daily attendance, a teacher's batch with the older child (added on the parent's mobile),
 * and a pending application for the younger sibling on the same mobile, for that batch.
 * Browser: the admin admits the sibling past the "Possible duplicate" prompt and they are enrolled in
 * the batch (no "no login" warning); the teacher finds both children on the attendance roster and
 * marks the sibling present and the older child absent. On a new device the parent's number's OTP
 * opens "Who's signing in?", and the sibling signs in and sees their own attendance. "Switch profile"
 * verifies the number again and signs in as the older child, who sees theirs.
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addStaff, createBatch, createInstitute, isoDate, uniqueMobile } from '../support/data';
import { outboxMark, waitForOtp } from '../support/outbox';
import {
  actionSheet,
  activePage,
  alertDialog,
  confirmAlert,
  expectToast,
  modal,
  signInWithOtp,
} from '../support/ui';

/** A parent's number in the 9591… range this spec uses (CONTRIBUTING.md, "Test mobiles"). */
const parentMobile = () => `9591${uniqueMobile().slice(4)}`;

test('siblings sharing a mobile: admitted into the batch, on the roster, "Who\'s signing in?"', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'siblings');
  const { api } = institute.admin;
  await api.put('/attendance/settings', { mode: 'daily' });
  const teacher = await addStaff(institute, 'teacher', 'Tara Teacher');
  const mobile = parentMobile();
  const older = await api.post<{ id: number; userId: number }>('/students', {
    name: 'Riya Sharma',
    mobile,
    branchId: institute.branchId,
  });
  const batch = await createBatch(institute, {
    label: 'Siblings',
    teacherUserId: teacher.id,
    studentUserIds: [older.userId],
  });
  const sibling = 'Kabir Sharma';
  await api.post('/admissions/applications', {
    name: sibling,
    mobile,
    branchId: institute.branchId,
    courseId: batch.courseId,
    batchId: batch.batchId,
  });

  await test.step('admin admits the sibling on the same mobile into the batch', async () => {
    const page = await openAs(institute.admin, '/admissions/applications');
    const row = activePage(page).locator('ion-item').filter({ hasText: sibling });
    await row.getByRole('button', { name: `Actions for ${sibling}` }).click();
    await actionSheet(page).getByRole('button', { name: 'Admit as student' }).click();
    const admit = modal(page);
    await expect(
      admit.getByRole('radio', { name: new RegExp(`^${batch.batchName} · from .* · 49 seats left$`) }),
    ).toBeChecked();
    await admit.getByRole('button', { name: 'Admit', exact: true }).click();
    await expect(alertDialog(page)).toContainText('Riya Sharma (');
    await confirmAlert(page, 'Admit anyway');
    await expectToast(page, new RegExp(`Admitted ${sibling} \\(.+\\) and enrolled them in the batch`));
    await expect(page).toHaveURL(/\/students\/\d+$/);
    const roster = await api.get<{ status: string; student: { name: string } }[]>(
      `/academics/batches/${batch.batchId}/students`,
    );
    expect(roster.map((r) => [r.student.name, r.status])).toEqual([
      ['Riya Sharma', 'active'],
      [sibling, 'active'],
    ]);
  });

  await test.step('teacher marks the sibling present and the older child absent', async () => {
    const page = await openAs(await loginWithPassword(http, teacher, newDevice('teacher')), '/attendance');
    const content = activePage(page);
    await content.locator('ion-item').filter({ hasText: batch.batchName }).click();
    await expect(page).toHaveURL(/\/attendance\/sessions\/\d+$/);
    const row = (name: string) => content.locator(`li[data-student="${name}"]`);
    await row(sibling)
      .getByRole('button', { name: `${sibling}: Not marked` })
      .click();
    await row('Riya Sharma').getByRole('button', { name: 'More choices for Riya Sharma' }).click();
    await actionSheet(page).getByRole('button', { name: 'Absent', exact: true }).click();
    await content.getByRole('button', { name: 'Save for now (2)' }).click();
    await expectToast(page, 'Saved 2 changes');
  });

  const today = `${isoDate()} · ${batch.batchName}`;
  const page = await openAs(null, '/attendance/my');
  const content = activePage(page);
  const profile = (name: string) => content.locator('ion-item').filter({ hasText: name });
  const account = page.locator('ion-menu ion-footer');

  await test.step('the number\'s OTP opens "Who\'s signing in?"; the sibling signs in', async () => {
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await signInWithOtp(page, mobile);
    await expect(page).toHaveURL(/\/choose-profile\?redirect=/);
    await expect(content.getByText('This mobile number signs in to more than one account.')).toBeVisible();
    await expect(content.locator('ion-item h2')).toHaveText(['Riya Sharma', sibling]);
    for (const name of ['Riya Sharma', sibling])
      await expect(profile(name)).toContainText(`student · ${institute.name}`);
    await profile(sibling).click();
    await expect(page).toHaveURL(/\/attendance\/my$/);
    await expect(content.locator('ion-item').filter({ hasText: today })).toContainText('Present');
    await expect(account).toContainText(sibling);
    await expect(account).toContainText(mobile);
  });

  await test.step('"Switch profile" verifies the number again and signs in as the older child', async () => {
    await account.getByRole('button', { name: 'Switch profile' }).click();
    await expect(alertDialog(page)).toContainText(`We'll send a code to ${mobile}.`);
    const since = outboxMark();
    await confirmAlert(page, 'Send code');
    await expect(page).toHaveURL(/\/otp$/);
    await expect(content.getByText('Enter the 6-digit code sent to')).toBeVisible();
    await content.getByLabel('OTP').fill(await waitForOtp(mobile, since));
    await content.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/choose-profile$/);
    await expect(profile(sibling)).toContainText('Signed in');
    await profile('Riya Sharma').click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(account).toContainText('Riya Sharma');
    await page.goto('/attendance/my');
    await expect(content.locator('ion-item').filter({ hasText: today })).toContainText('Absent');
  });
});
