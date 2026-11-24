/**
 * Spec §7 — Attendance: an absent student's parent receives the configured alert.
 *
 * Setup (API): daily attendance with parent absent alerts on; a teacher's batch with three
 * students, each with a guardian. Browser: a parent signs in with a mobile OTP (nothing to see
 * yet); the teacher marks one student present and one absent, saves, then submits the roll call,
 * which marks the unmarked third student absent. The parent then finds the alert in the app's
 * notifications. Both absent students' parents also get the SMS (dev outbox) and the present
 * student's parent gets nothing.
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import {
  addGuardian,
  addStaff,
  addStudent,
  createBatch,
  createInstitute,
  isoDate,
  messageDay,
} from '../support/data';
import { outboxMark, outboxMessages, waitForMessage } from '../support/outbox';
import {
  actionSheet,
  activePage,
  alertDialog,
  confirmAlert,
  expectToast,
  signInWithOtp,
} from '../support/ui';

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

    // Students can also check themselves in here, so nobody starts as present: tap marks present,
    // "More choices" picks any other status, and submitting marks whoever is left absent.
    const row = (name: string) => content.locator(`li[data-student="${name}"]`);
    await row(present.name)
      .getByRole('button', { name: `${present.name}: Not marked` })
      .click();
    await expect(row(present.name)).toContainText('Present');
    await row(absent.name)
      .getByRole('button', { name: `More choices for ${absent.name}` })
      .click();
    await actionSheet(page).getByRole('button', { name: 'Absent', exact: true }).click();
    await expect(row(absent.name)).toContainText('Absent');
    await content.getByRole('button', { name: 'Save for now (2)' }).click();
    await expectToast(page, 'Saved 2 changes');

    await content.getByRole('button', { name: 'Submit · 1 present, 1 absent, 1 not marked' }).click();
    await expect(alertDialog(page)).toContainText('1 student is not marked yet and will be marked absent.');
    await confirmAlert(page, 'Submit');
    await expectToast(page, 'Attendance submitted');
    await expect(content.getByText('Submitted', { exact: true })).toBeVisible();
    const summary = content.getByRole('group', { name: 'Attendance summary — tap to filter' });
    await expect(summary.getByRole('button', { name: /Present$/ })).toHaveText('1 Present');
    await expect(summary.getByRole('button', { name: /Absent$/ })).toHaveText('2 Absent');
    await expect(row(unmarked.name)).toContainText('Absent');
    return day;
  });
  expect(date).toBe(isoDate());

  const alertText = (name: string) =>
    `${name} was marked absent in ${batch.batchName} on ${messageDay(date)}.`;

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
