/**
 * Spec §7 — Attendance: an absent student's parent receives the configured alert.
 *
 * Setup (API): daily attendance with parent absent alerts on; a teacher's batch with three
 * students, each with a guardian. Browser: a parent signs in with a mobile OTP (nothing to see
 * yet); the teacher marks one student present and one absent, saves, then closes the session,
 * which marks the unmarked third student absent. The parent then finds the alert in the app's
 * notifications. Both absent students' parents also get the SMS (dev outbox) and the present
 * student's parent gets nothing.
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addGuardian, addStaff, addStudent, createBatch, createInstitute, isoDate } from '../support/data';
import { outboxMark, outboxMessages, waitForMessage } from '../support/outbox';
import { activePage, alertDialog, confirmAlert, expectToast, signInWithOtp } from '../support/ui';

test('attendance marked absent → parent receives the absent alert', async ({ http, superAdmin, openAs }) => {
  const institute = await createInstitute(http, superAdmin, 'attendance');
  await institute.admin.api.put('/attendance/settings', { mode: 'daily', absentAlerts: true });
  const teacher = await addStaff(institute, 'teacher', 'Tanvi Teacher');
  const students = [];
  for (const name of ['Priya Present', 'Arjun Absent', 'Uma Unmarked']) {
    const student = await addStudent(institute, name);
    students.push({ ...student, guardian: await addGuardian(institute, student, `Parent of ${name}`) });
  }
  const [present, absent, unmarked] = students;
  const batch = await createBatch(institute, {
    label: 'Morning',
    teacherUserId: teacher.id,
    studentUserIds: students.map((s) => s.id),
  });
  const since = outboxMark();

  const parent = await test.step('parent signs in with a mobile OTP; no alerts yet', async () => {
    const page = await openAs(null, '/notifications');
    await signInWithOtp(page, absent.guardian.mobile);
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(activePage(page).getByText("You're all caught up.")).toBeVisible();
    return page;
  });

  const date = await test.step('teacher takes attendance and closes the session', async () => {
    const page = await openAs(await loginWithPassword(http, teacher, newDevice('teacher')), '/attendance');
    const content = activePage(page);
    const day = await content.getByLabel('Date').inputValue();
    const batchItem = content.locator('ion-item').filter({ hasText: batch.batchName });
    await expect(batchItem).toContainText('Not started');
    await batchItem.click();
    await expect(page).toHaveURL(/\/attendance\/sessions\/\d+$/);

    const row = (name: string) => content.locator('ion-item').filter({ hasText: name });
    await row(present.name).getByRole('button', { name: 'P', exact: true }).click();
    await row(absent.name).getByRole('button', { name: 'A', exact: true }).click();
    await content.getByRole('button', { name: 'Save (2)' }).click();
    await expectToast(page, 'Saved 2 mark(s)');

    await content.getByRole('button', { name: 'Close & mark rest absent' }).click();
    await expect(alertDialog(page)).toContainText(
      '1 unmarked student(s) will be marked absent and parents alerted.',
    );
    await confirmAlert(page, 'Close');
    await expectToast(page, 'Attendance closed');
    await expect(content.locator('ion-chip').filter({ hasText: 'Present' })).toHaveText('Present 1');
    await expect(content.locator('ion-chip').filter({ hasText: 'Absent' })).toHaveText('Absent 2');
    return day;
  });
  expect(date).toBe(isoDate());

  const alertText = (name: string) => `${name} was marked absent in ${batch.batchName} on ${date}.`;

  await test.step("absent students' parents get the SMS; the present student's parent does not", async () => {
    for (const student of [absent, unmarked])
      await waitForMessage(
        (m) =>
          m.channel === 'sms' && m.to === student.guardian.mobile && m.body.includes(alertText(student.name)),
        { since, description: `Absent SMS to ${student.guardian.name}` },
      );
    expect(outboxMessages(since).filter((m) => m.to === present.guardian.mobile)).toEqual([]);
  });

  await test.step('parent sees the alert in the app notifications', async () => {
    // The in-app alert is written together with the SMS awaited above, so one reload shows it.
    await parent.reload();
    const alerts = activePage(parent).locator('ion-item').filter({ hasText: 'Absent today' });
    await expect(alerts).toHaveCount(1);
    await expect(alerts).toContainText(alertText(absent.name));
    await expect(activePage(parent).getByText(unmarked.name)).toBeHidden();
  });
});
