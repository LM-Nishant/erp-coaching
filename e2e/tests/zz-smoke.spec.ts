import { expect, test } from '../support/fixtures';
import { activePage } from '../support/ui';
import { addGuardian, addStudent, createInstitute } from '../support/data';
import { loginWithOtp } from '../support/api';

test('smoke', async ({ http, superAdmin, openAs }) => {
  const institute = await createInstitute(http, superAdmin, 'smoke');
  const page = await openAs(institute.admin);
  await expect(activePage(page).getByRole('heading', { name: `Hello, ${institute.adminUser.name}` })).toBeVisible();
  const student = await addStudent(institute, 'Smoke Student');
  const guardian = await addGuardian(institute, student, 'Smoke Parent');
  const parent = await loginWithOtp(http, guardian.mobile);
  console.log(JSON.stringify({ student, guardian, parentUser: parent.user }));
  const parentPage = await openAs(parent);
  await expect(activePage(parentPage).getByRole('heading', { name: `Hello, ${guardian.name}` })).toBeVisible();
});
