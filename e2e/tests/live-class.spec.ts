/**
 * Spec §7 — Live class: the teacher schedules a class → the student is notified → the signed-in
 * student joins → chat, Q&A, a poll and a microphone permission → the recording is generated and
 * linked to the course and batch.
 *
 * Setup (API): a teacher's batch with one student. Browser (Chromium's fake camera and microphone,
 * the default dev WebRTC streaming provider): the teacher schedules the class and the student finds
 * the notification. The teacher goes live and the student joins from the Live classes list. They
 * chat, the student asks a question that the teacher marks answered, votes in the teacher's poll and
 * raises a hand, and the teacher allows the student's microphone. The teacher ends the class: the
 * in-browser recording is uploaded, the class page lists it with the attendance, and the recording
 * is published as a lecture of the course for the batch, which the student opens in the LMS.
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addStaff, addStudent, createBatch, createInstitute, uniqueId } from '../support/data';
import { activePage, chooseOption, expectToast, modal, selectSegment } from '../support/ui';

// Headless Chromium's audio clock only runs on its fake output device, and the recorder needs it.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output'],
  },
});

interface Paged<T> {
  items: T[];
  total: number;
}
interface Resource {
  title: string;
  type: string;
  status: string;
  batchIds: number[];
}

test('live class: schedule → notify → join → chat, Q&A, poll, mic → recording in the LMS', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'live');
  const teacher = await addStaff(institute, 'teacher', 'Tara Teacher');
  const student = await addStudent(institute, 'Sam Student');
  const batch = await createBatch(institute, {
    label: 'Optics',
    teacherUserId: teacher.id,
    studentUserIds: [student.id],
  });
  const title = `Optics revision ${uniqueId()}`;

  const host = await openAs(await loginWithPassword(http, teacher, newDevice('teacher')), '/live-classes');
  await host.context().grantPermissions(['camera', 'microphone']);
  const hostView = activePage(host);

  await test.step('teacher schedules the class for the batch', async () => {
    await hostView.getByRole('button', { name: 'Schedule live class' }).click();
    const form = modal(host);
    await chooseOption(form.locator('ion-select').filter({ hasText: 'Batch' }), batch.batchName);
    await form.getByLabel('Title', { exact: true }).fill(title);
    await form.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expectToast(host, 'Live class scheduled');
    await expect(host).toHaveURL(/\/live-classes\/\d+$/);
  });

  const learner = await test.step('student is notified of the class', async () => {
    const page = await openAs(await loginWithPassword(http, student, newDevice('student')), '/notifications');
    await page.context().grantPermissions(['camera', 'microphone']);
    // The in-app notification is stored before the schedule request returns.
    await expect(
      activePage(page).locator('ion-item').filter({ hasText: 'Live class scheduled' }),
    ).toContainText(`Live class "${title}" starts at`);
    return page;
  });
  const learnerView = activePage(learner);

  await test.step('teacher goes live; the class records automatically', async () => {
    await hostView.getByRole('button', { name: 'Go live' }).click();
    await expect(host).toHaveURL(/\/live-classes\/\d+\/room$/);
    await expect(hostView.getByText('● LIVE')).toBeVisible();
    await expect(hostView.getByText('⏺ Recording')).toBeVisible();
    await expect(hostView.getByText('0 students online')).toBeVisible();
  });

  await test.step('student joins from the live classes list', async () => {
    await learner.goto('/live-classes');
    await learnerView
      .locator('ion-item')
      .filter({ hasText: title })
      .getByRole('link', { name: 'Join', exact: true })
      .click();
    await expect(learner).toHaveURL(/\/live-classes\/\d+\/room$/);
    await expect(learnerView.getByText('● LIVE')).toBeVisible();
    await expect(hostView.getByText('1 student online')).toBeVisible();
  });

  await test.step('teacher and student chat', async () => {
    await hostView.getByPlaceholder('Message', { exact: true }).fill('Welcome to the revision class!');
    await hostView.getByRole('button', { name: 'Send' }).click();
    await expect(learnerView.getByText('Welcome to the revision class!')).toBeVisible();
    await learnerView.getByPlaceholder('Message', { exact: true }).fill('Good morning, ma’am');
    await learnerView.getByRole('button', { name: 'Send' }).click();
    await expect(hostView.getByText('Good morning, ma’am')).toBeVisible();
  });

  await test.step('student asks a question; the teacher marks it answered', async () => {
    const question = 'Why does a prism split white light?';
    await selectSegment(learnerView, 'Q&A');
    await learnerView.getByPlaceholder('Ask a question').fill(question);
    await learnerView.getByRole('button', { name: 'Ask', exact: true }).click();
    await selectSegment(hostView, 'Q&A');
    await hostView
      .locator('ion-card')
      .filter({ hasText: question })
      .getByRole('button', { name: 'Mark answered' })
      .click();
    await expect(learnerView.locator('ion-card').filter({ hasText: question })).toContainText('Answered');
  });

  await test.step('teacher launches a poll; the student votes', async () => {
    const question = 'Ready for the quiz?';
    await selectSegment(hostView, 'Polls');
    await hostView.getByPlaceholder('Question', { exact: true }).fill(question);
    await hostView.getByPlaceholder('Option 1', { exact: true }).fill('Yes');
    await hostView.getByPlaceholder('Option 2', { exact: true }).fill('Not yet');
    await hostView.getByRole('button', { name: 'Launch poll' }).click();
    await selectSegment(learnerView, 'Polls');
    const poll = learnerView.locator('ion-card').filter({ hasText: question });
    await poll.getByText('Yes', { exact: true }).click();
    await expect(poll).toContainText('1 vote');
    await expect(hostView.locator('ion-card').filter({ hasText: question })).toContainText('1 · 100%');
  });

  await test.step('student raises a hand; the teacher allows the microphone', async () => {
    await learnerView.getByRole('button', { name: 'Raise hand' }).click();
    await expect(learnerView.getByRole('button', { name: 'Lower hand' })).toBeVisible();
    await selectSegment(hostView, 'People');
    await hostView
      .locator('ion-item')
      .filter({ hasText: `✋ ${student.name}` })
      .getByRole('button', { name: 'Allow mic' })
      .click();
    await expect(learnerView.getByRole('button', { name: 'Your mic is on' })).toBeDisabled();
    await expect(
      learnerView.getByText('The teacher allowed your microphone — everyone can hear you.'),
    ).toBeVisible();
    await expect(
      hostView.locator('ion-item').filter({ hasText: student.name }).filter({ hasText: 'Speaking' }),
    ).toBeVisible();
  });

  await test.step('teacher ends the class; the class page lists the recording and attendance', async () => {
    await hostView.getByRole('button', { name: 'End class' }).click();
    await expectToast(host, 'Class ended');
    await expect(host).toHaveURL(/\/live-classes\/\d+$/);
    await expect(hostView.locator('ion-item').filter({ hasText: title })).toBeVisible();
    await expect(hostView.getByText('Attendance (1/1 students joined)')).toBeVisible();
    await expect(learnerView.getByText('This live class has ended')).toBeVisible();
  });

  await test.step('the recording is published as a lecture of the course, for the batch', async () => {
    await expect
      .poll(async () => {
        const { items } = await institute.admin.api.get<Paged<Resource>>(
          `/lms/resources?courseId=${batch.courseId}`,
        );
        return items.map(({ title, type, status, batchIds }) => ({ title, type, status, batchIds }));
      })
      .toEqual([{ title, type: 'video', status: 'published', batchIds: [batch.batchId] }]);

    await learner.goto('/lms');
    await learnerView.locator('ion-card').filter({ hasText: batch.courseName }).click();
    await learnerView.locator('ion-item').filter({ hasText: title }).click();
    await expect(learner).toHaveURL(/\/lms\/resources\/\d+$/);
    await expect(learnerView.getByText('Recording of the live class on')).toBeVisible();
  });
});
