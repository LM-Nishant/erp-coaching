/**
 * Course purchase → batch enrolment (final wave #19): a student buys a course online, picks one of
 * its open batches, pays through the mock gateway, and is enrolled in that batch automatically.
 *
 * Setup (API): a new institute with the mock fee gateway enabled, a course with two open batches
 * and a course fee structure (₹12,500), and a student who is in neither batch. Browser: the student
 * opens "Buy course", chooses the second batch, pays with the mock gateway and lands on "My fees".
 * The enrolment runs in the jobs worker; the purchase page then says the student is enrolled in the
 * chosen batch, and the admin finds them under "Enrolled" on "Course enrolments".
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addStudent, createBatch, createInstitute, isoDate, uniqueId } from '../support/data';
import { activePage, alertDialog, confirmAlert, expectToast, selectSegment } from '../support/ui';

interface Quote {
  enrolment: { status: string; batchName: string | null } | null;
}

test('course purchase → mock payment → enrolled in the chosen batch', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'course');
  const { api } = institute.admin;
  const first = await createBatch(institute, { label: 'Chemistry' });
  const code = uniqueId().toUpperCase();
  const chosenName = `Chemistry evening batch ${code}`;
  const chosen = await api.post<{ id: number }>('/academics/batches', {
    branchId: institute.branchId,
    courseId: first.courseId,
    academicSessionId: first.academicSessionId,
    name: chosenName,
    code: `B2-${code}`,
    capacity: 20,
    startDate: isoDate(10),
    status: 'active',
  });
  await api.post('/fees/structures', {
    name: `${first.courseName} fee`,
    courseId: first.courseId,
    components: [{ name: 'Course fee', amount: 1_250_000 }],
    instalmentPlan: { type: 'one_time', count: 1, firstDueDate: isoDate(30) },
  });
  await api.put('/fees/gateways/mock', { enabled: true, isDefault: true });
  const student = await addStudent(institute, 'Kavya Buyer');
  const session = await loginWithPassword(http, student, newDevice('student'));

  await test.step('student picks a batch and pays with the mock gateway', async () => {
    const page = await openAs(session, `/my-fees/buy/${first.courseId}`);
    const content = activePage(page);
    await expect(content.locator('ion-card-title')).toHaveText(first.courseName);
    await content.locator('ion-select').click();
    const options = alertDialog(page);
    await expect(options.getByRole('radio', { name: new RegExp(`^${first.batchName} · `) })).toBeVisible();
    await options
      .getByRole('radio', { name: new RegExp(`^${chosenName} · from .* · 20 seats left$`) })
      .click();
    await confirmAlert(page, 'OK');
    await expect(content.locator('ion-select')).toContainText(chosenName);

    await content.getByRole('button', { name: 'Pay ₹12,500.00', exact: true }).click();
    await expect(content).toContainText('Test gateway. No real money moves.');
    await content.getByRole('button', { name: 'Pay now', exact: true }).click();
    await expectToast(page, 'Payment successful. Your course is unlocked.');
    await expect(page).toHaveURL(/\/my-fees$/);
  });

  await test.step('the student is enrolled in the chosen batch', async () => {
    await expect
      .poll(
        async () => (await session.api.get<Quote>(`/fees/me/courses/${first.courseId}/quote`)).enrolment,
        {
          timeout: 60_000,
        },
      )
      .toMatchObject({ status: 'enrolled', batchName: chosenName });
    const page = await openAs(session, `/my-fees/buy/${first.courseId}`);
    const content = activePage(page);
    await expect(content).toContainText('You already have access to this course.');
    await expect(content).toContainText(`You are enrolled in ${chosenName}.`);
    const roster = await api.get<{ studentUserId: number; status: string }[]>(
      `/academics/batches/${chosen.id}/students`,
    );
    expect(roster).toEqual([expect.objectContaining({ studentUserId: student.id, status: 'active' })]);
  });

  await test.step('admin sees the enrolment on "Course enrolments"', async () => {
    const page = await openAs(institute.admin, '/fees/course-enrolments');
    const content = activePage(page);
    await selectSegment(content, 'Enrolled');
    const row = content.locator('ion-item').filter({ hasText: student.name });
    await expect(row).toContainText(first.courseName);
    await expect(row).toContainText(`Batch ${chosenName}`);
  });
});
