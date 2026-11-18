/**
 * Spec §7 — Parent-teacher appointment: parent requests a slot → teacher accepts → the parent is
 * told, and the meeting's notes and history are kept.
 *
 * Setup (API): a teacher's batch with one student (and a guardian), and a one-off window of
 * free time the teacher offers in two days (16:00–16:30, 15-minute meetings, in person or online,
 * Room 4). Browser: the parent signs in with a mobile OTP, picks the teacher and the 16:00 slot,
 * asks for an in-person meeting with an agenda and sends the request. The teacher finds it under
 * Pending and approves it with a note for the parent and a more precise location. The parent then
 * sees the confirmed meeting (note, location, history) and the in-app confirmation.
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addGuardian, addStaff, addStudent, createBatch, createInstitute, isoDate } from '../support/data';
import { activePage, alertDialog, chooseOption, confirmAlert, expectToast, selectSegment, signInWithOtp } from '../support/ui';
import type { Locator } from '@playwright/test';

test('parent-teacher appointment: parent requests a slot → teacher accepts', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'meetings');
  const teacher = await addStaff(institute, 'teacher', 'Tara Teacher');
  const student = await addStudent(institute, 'Kabir Kid');
  const guardian = await addGuardian(institute, student, 'Parent of Kabir Kid', 'father');
  const batch = await createBatch(institute, {
    label: 'Maths',
    teacherUserId: teacher.id,
    studentUserIds: [student.id],
  });
  const teacherSession = await loginWithPassword(http, teacher, newDevice('teacher'));
  const date = isoDate(2);
  await teacherSession.api.post('/appointments/slots', {
    kind: 'one_off',
    date,
    startTime: '16:00',
    endTime: '16:30',
    slotMinutes: 15,
    mode: 'both',
    location: 'Room 4',
    branchId: institute.branchId,
  });
  const when = `${date} · 16:00–16:15`;
  const agenda = 'How can Kabir improve in algebra?';
  const note = 'Please bring his last two test papers.';
  const location = 'Room 4, first floor';
  /** The meeting's summary row (date, time, status badge, mode) on the detail page. */
  const summary = (content: Locator) => content.locator('ion-item').filter({ hasText: when }).first();

  const { parent, appointmentPath } = await test.step('parent signs in and requests a free slot', async () => {
    const page = await openAs(null, '/appointments');
    await signInWithOtp(page, guardian.mobile);
    await expect(page).toHaveURL(/\/appointments$/);
    const content = activePage(page);
    await expect(content.getByText('No meetings here.')).toBeVisible();
    await content.getByRole('link', { name: 'Request', exact: true }).click();
    await expect(page).toHaveURL(/\/appointments\/request$/);

    // The only child is preselected; the teachers offered are those of the child's batches.
    await expect(content.locator('ion-select').filter({ hasText: 'Child' })).toContainText(student.name);
    await chooseOption(
      content.locator('ion-select').filter({ hasText: 'Teacher' }),
      `${teacher.name} (${batch.batchName})`,
    );
    const slot = content.locator('ion-chip').filter({ hasText: '16:00' });
    await expect(content.locator('ion-chip')).toHaveText(['16:00', '16:15']);
    await slot.click();
    await selectSegment(content, 'In person');
    await expect(content.getByText('At Room 4')).toBeVisible();
    await content.getByLabel('What would you like to discuss?').fill(agenda);
    await content.getByRole('button', { name: `Request ${date} 16:00` }).click();
    await expectToast(page, 'Request sent. The teacher will confirm.');

    await expect(page).toHaveURL(/\/appointments\/\d+$/);
    await expect(summary(content).locator('ion-badge')).toHaveText('Requested');
    await expect(summary(content)).toContainText('In person');
    return { parent: page, appointmentPath: new URL(page.url()).pathname };
  });

  await test.step('teacher finds the pending request and approves it', async () => {
    const page = await openAs(teacherSession, '/appointments');
    const content = activePage(page);
    await selectSegment(content, 'Pending');
    const request = content.locator('ion-item').filter({ hasText: student.name });
    await expect(request).toContainText(when);
    await expect(request).toContainText(`by ${guardian.name}`);
    await expect(request).toContainText(agenda);
    await expect(request.locator('ion-badge')).toHaveText('Requested');
    await request.click();
    await expect(page).toHaveURL(new RegExp(`${appointmentPath}$`));

    await content.getByRole('button', { name: 'Approve', exact: true }).click();
    const alert = alertDialog(page);
    await expect(alert).toContainText('Approve meeting');
    await alert.getByPlaceholder('Note to the parent (optional)').fill(note);
    await expect(alert.getByPlaceholder('Location')).toHaveValue('Room 4');
    await alert.getByPlaceholder('Location').fill(location);
    await confirmAlert(page, 'Approve');
    await expectToast(page, 'Meeting confirmed');
    await expect(summary(content).locator('ion-badge')).toHaveText('Confirmed');
  });

  await test.step("parent sees the confirmed meeting, the teacher's note and the history", async () => {
    const content = activePage(parent);
    await parent.reload();
    await expect(summary(content).locator('ion-badge')).toHaveText('Confirmed');
    await expect(content.locator('ion-item').filter({ hasText: "Teacher's note" })).toContainText(note);
    await expect(content.getByText(location, { exact: true })).toBeVisible();
    await expect(content.locator('ion-item').filter({ hasText: `Requested · ${guardian.name}` })).toContainText(
      agenda,
    );
    await expect(content.locator('ion-item').filter({ hasText: `Approved · ${teacher.name}` })).toContainText(
      note,
    );
  });

  await test.step('parent gets the confirmation in the app notifications', async () => {
    await parent.goto('/notifications');
    const confirmed = activePage(parent).locator('ion-item').filter({ hasText: 'Meeting confirmed' });
    await expect(async () => {
      await parent.reload();
      await expect(confirmed).toHaveCount(1, { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(confirmed).toContainText(
      `Your meeting with ${teacher.name} on ${date} at 16:00 (offline) is confirmed.`,
    );
  });
});
