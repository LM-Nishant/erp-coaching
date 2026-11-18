/**
 * Spec §7 — Examination: exam scheduled → student attempts → objective answers auto-scored →
 * authorised publication → the parent sees the result in the parent portal.
 *
 * Setup (API): a batch with one student (and a guardian), and a live, scheduled exam for it with
 * three single-answer MCQs from the question bank (4 marks each, pass mark 6). Browser: the student
 * takes the exam (two right, one wrong) and submits. The exam window then closes (moved to the past
 * through the API, standing in for time passing). The parent signs in with a mobile OTP and has no
 * results yet; the institute admin sees the auto-scored attempt and publishes the results; the
 * parent then finds 8 / 12 (passed) in the parent portal and opens the result. The parent also
 * gets the result SMS (dev outbox).
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addGuardian, addStudent, createBatch, createInstitute, uniqueId } from '../support/data';
import { outboxMark, waitForMessage } from '../support/outbox';
import { activePage, alertDialog, confirmAlert, expectToast, signInWithOtp } from '../support/ui';

const KEYS = ['A', 'B', 'C', 'D'];
/** In exam order; the student picks `choose` (the last answer is wrong): 4 + 4 + 0 = 8 of 12. */
const QUESTIONS = [
  { text: 'What is 7 × 6?', options: ['36', '42', '48', '54'], correct: 'B', choose: 'B' },
  {
    text: 'Which gas do plants absorb for photosynthesis?',
    options: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Helium'],
    correct: 'C',
    choose: 'C',
  },
  {
    text: 'At what temperature in Celsius does water boil at sea level?',
    options: ['90', '100', '110', '120'],
    correct: 'B',
    choose: 'A',
  },
];

test('exam publish → parent sees the result in the parent portal', async ({ http, superAdmin, openAs }) => {
  const institute = await createInstitute(http, superAdmin, 'exam');
  const student = await addStudent(institute, 'Esha Examinee');
  const guardian = await addGuardian(institute, student, 'Parent of Esha Examinee');
  const batch = await createBatch(institute, { label: 'Physics', studentUserIds: [student.id] });
  const { api } = institute.admin;

  const bank = await api.post<{ id: number }>('/question-bank/banks', { name: 'Weekly test questions' });
  const questionIds: number[] = [];
  for (const q of QUESTIONS) {
    const question = await api.post<{ id: number }>(`/question-bank/banks/${bank.id}/questions`, {
      type: 'single',
      text: q.text,
      options: q.options.map((text, i) => ({ key: KEYS[i], text })),
      answerKey: { options: [q.correct] },
      status: 'active',
    });
    questionIds.push(question.id);
  }
  const title = `Weekly test ${uniqueId()}`;
  const now = Date.now();
  const exam = await api.post<{ id: number; sections: { id: number }[] }>('/exams', {
    title,
    batchId: batch.batchId,
    // Opened half an hour ago, so the window can later be closed without being shorter than the duration.
    startAt: new Date(now - 30 * 60_000).toISOString(),
    endAt: new Date(now + 60 * 60_000).toISOString(),
    durationMinutes: 20,
    defaultMarks: 4,
    passMarks: 6,
  });
  await api.post(`/exams/${exam.id}/questions`, { sectionId: exam.sections[0].id, questionIds, marks: 4 });
  await api.post(`/exams/${exam.id}/schedule`);

  await test.step('student takes the exam and submits it', async () => {
    const page = await openAs(await loginWithPassword(http, student, newDevice('student')), '/my-exams');
    const content = activePage(page);
    const item = content.locator('ion-item').filter({ hasText: title });
    await expect(item).toContainText('Live');
    await item.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(alertDialog(page)).toContainText('Duration: 20 minutes. Total marks: 12.');
    await confirmAlert(page, 'Start exam');
    await expect(page).toHaveURL(/\/my-exams\/attempts\/\d+$/);

    for (const [i, q] of QUESTIONS.entries()) {
      await expect(content.getByText(`Question ${i + 1} of ${QUESTIONS.length}`)).toBeVisible();
      await expect(content.locator('.q-text')).toHaveText(q.text);
      const option = content.getByRole('radio', {
        name: `${q.choose}. ${q.options[KEYS.indexOf(q.choose)]}`,
      });
      await option.click();
      await expect(option).toBeChecked();
      if (i < QUESTIONS.length - 1) await content.getByRole('button', { name: 'Save & next' }).click();
    }
    await content.getByRole('button', { name: 'Submit exam' }).first().click();
    await expect(alertDialog(page)).toContainText(`Answered: ${QUESTIONS.length} of ${QUESTIONS.length}.`);
    await confirmAlert(page, 'Submit');
    await expectToast(page, 'Exam submitted');
    await expect(page).toHaveURL(/\/my-exams$/);
    await expect(item).toContainText('Submitted · awaiting result');
  });

  // Time passes: results can only be published once the exam window has closed.
  await api.patch(`/exams/${exam.id}`, { endAt: new Date(Date.now() - 1000).toISOString() });

  const parent = await test.step('parent signs in with a mobile OTP; nothing is published yet', async () => {
    const page = await openAs(null, '/exam-results');
    await signInWithOtp(page, guardian.mobile);
    await expect(page).toHaveURL(/\/exam-results$/);
    await expect(activePage(page).getByText('No results have been published yet.')).toBeVisible();
    return page;
  });

  const since = outboxMark();
  await test.step('institute admin checks the auto-scored attempt and publishes the results', async () => {
    const page = await openAs(institute.admin, `/exams/${exam.id}/results`);
    const content = activePage(page);
    await expect(content.locator('ion-card-title').first()).toHaveText(title);
    await expect(content.locator('ion-item').filter({ hasText: student.name })).toContainText('8 / 12');
    await content.getByRole('button', { name: 'Publish results' }).click();
    await expect(alertDialog(page)).toContainText('Publish results?');
    await confirmAlert(page, 'Publish');
    await expectToast(page, 'Results published');
    await expect(content.getByRole('button', { name: 'Unpublish' })).toBeVisible();
  });

  await test.step('parent sees the result in the parent portal', async () => {
    const content = activePage(parent);
    await parent.reload();
    const result = content.locator('ion-item').filter({ hasText: title });
    await expect(result).toContainText(student.name);
    await expect(result).toContainText('Score 8 / 12 (66.7%)');
    await expect(result.locator('ion-badge')).toHaveText('Passed');

    await result.click();
    await expect(parent).toHaveURL(/\/exam-results\/\d+$/);
    const summary = content.locator('ion-card').first();
    await expect(summary).toContainText(student.name);
    await expect(summary.locator('ion-card-title')).toHaveText('8 / 12');
    await expect(summary.locator('ion-chip').filter({ hasText: '%' })).toHaveText('66.7%');
    await expect(summary.locator('ion-chip').filter({ hasText: 'Passed' })).toBeVisible();
  });

  await waitForMessage(
    (m) =>
      m.channel === 'sms' &&
      m.to === guardian.mobile &&
      m.body.includes(`Result of ${title} for ${student.name}: 8/12`),
    { since, description: 'result SMS to the parent' },
  );
});
