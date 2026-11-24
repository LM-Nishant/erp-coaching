/**
 * Doubts — a student asks a doubt with a photo → the batch teacher answers → the student marks it
 * solved.
 *
 * Setup (API): a batch with one teacher and one student. Browser: the student writes a doubt,
 * attaches a photo of their work and sends it. The teacher finds it under "To answer" in the doubt
 * inbox and replies. The student sees the answer and marks the doubt as solved.
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addStaff, addStudent, createBatch, createInstitute } from '../support/data';
import { activePage, selectSegment } from '../support/ui';

// A 1×1 PNG: enough for the photo picker and the upload's image check.
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('doubts: student asks with a photo → teacher answers → student marks it solved', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const institute = await createInstitute(http, superAdmin, 'doubts');
  const teacher = await addStaff(institute, 'teacher', 'Tara Teacher');
  const student = await addStudent(institute, 'Kabir Kid');
  await createBatch(institute, { label: 'Physics', teacherUserId: teacher.id, studentUserIds: [student.id] });
  const question = 'Why does the speed double when the radius halves in question 4?';
  const answer = 'With the same period, halving the radius halves the speed. Check step 2 again.';

  const { page: studentPage, doubtPath } = await test.step('student asks a doubt with a photo', async () => {
    const session = await loginWithPassword(http, student, newDevice('student'));
    const page = await openAs(session, '/doubts');
    const content = activePage(page);
    await expect(content.getByText('No doubts yet')).toBeVisible();
    await page.goto('/doubts/ask');
    await page.getByTestId('doubt-question').locator('textarea').fill(question);
    await activePage(page)
      .locator('input[type=file]')
      .setInputFiles({ name: 'work.png', mimeType: 'image/png', buffer: PHOTO });
    await page.getByTestId('send-doubt').click();
    await expect(page).toHaveURL(/\/doubts\/\d+$/);
    const detail = activePage(page);
    await expect(detail.getByText(question)).toBeVisible();
    await expect(detail.locator('.status-chip')).toHaveText('Waiting');
    await expect(detail.locator('img').first()).toBeVisible();
    return { page, doubtPath: new URL(page.url()).pathname };
  });

  await test.step('teacher answers it from the doubt inbox', async () => {
    const session = await loginWithPassword(http, teacher, newDevice('teacher'));
    const page = await openAs(session, '/doubts/inbox');
    const content = activePage(page);
    await content.getByText(question).click();
    await expect(page).toHaveURL(new RegExp(`${doubtPath}$`));
    await page.getByTestId('doubt-reply').locator('textarea').fill(answer);
    await page.getByTestId('send-reply').click();
    await expect(activePage(page).locator('.status-chip')).toHaveText('Answered');

    await page.goto('/doubts/inbox');
    await selectSegment(activePage(page), 'Answered');
    await expect(activePage(page).getByText(question)).toBeVisible();
  });

  await test.step('student reads the answer and marks the doubt solved', async () => {
    await studentPage.goto(doubtPath);
    const detail = activePage(studentPage);
    await expect(detail.getByText(answer)).toBeVisible();
    await expect(detail.locator('.status-chip')).toHaveText('Answered');
    await studentPage.getByTestId('mark-solved').click();
    await expect(activePage(studentPage).locator('.status-chip')).toHaveText('Solved');
    await expect(activePage(studentPage).getByText('This doubt is solved.', { exact: false })).toBeVisible();
  });
});
