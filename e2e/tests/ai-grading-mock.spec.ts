/**
 * AI-assisted grading with the mock provider (final wave #19): a student's descriptive answer is
 * graded in the background, and the teacher reviews and accepts the AI suggestion.
 *
 * Setup (API): the super admin selects the built-in mock AI provider (deterministic, no network).
 * A new institute with a batch, one student and an AI-assisted exam with one descriptive question
 * (10 marks, model answer and rubric). The student starts the exam, types an answer and submits it,
 * which queues a grading job for the jobs worker. Browser: the institute admin opens "Evaluate
 * answers", sees the completed mock job ("simulated") and the suggestion 8.50 / 10 with its feedback,
 * and accepts it; the marks become final.
 */
import { expect, test } from '../support/fixtures';
import { loginWithPassword, newDevice } from '../support/api';
import { addStudent, createBatch, createInstitute, uniqueId } from '../support/data';
import { activePage, expectToast, selectSegment } from '../support/ui';

const QUESTION = "State Newton's second law.";
const ANSWER = 'Force equals mass times acceleration, formula F = ma.';
/** The mock grader scores key-point coverage of the model answer and rubric: 6 of 7 points. */
const FEEDBACK =
  'Covered 6 of 7 key points (86%). Mentions: force, equals, mass, times, acceleration, formula. Missing: units.';

test('AI grading with the mock provider → teacher accepts the suggestion', async ({
  http,
  superAdmin,
  openAs,
}) => {
  await superAdmin.api.put('/admin/ai/settings', {
    provider: 'mock',
    baseUrl: 'mock://local',
    model: 'mock-ai-1',
    jsonMode: true,
  });
  const institute = await createInstitute(http, superAdmin, 'ai');
  const student = await addStudent(institute, 'Arjun Answerer');
  const batch = await createBatch(institute, { label: 'Physics', studentUserIds: [student.id] });
  const { api } = institute.admin;

  const bank = await api.post<{ id: number }>('/question-bank/banks', { name: 'Theory questions' });
  const question = await api.post<{ id: number }>(`/question-bank/banks/${bank.id}/questions`, {
    type: 'descriptive',
    text: QUESTION,
    answerKey: { modelAnswer: 'Force equals mass times acceleration.', rubric: 'Formula with units' },
    status: 'active',
  });
  const title = `Theory test ${uniqueId()}`;
  const now = Date.now();
  const exam = await api.post<{ id: number; sections: { id: number }[] }>('/exams', {
    title,
    batchId: batch.batchId,
    startAt: new Date(now - 60_000).toISOString(),
    endAt: new Date(now + 60 * 60_000).toISOString(),
    durationMinutes: 30,
    evaluationMode: 'ai_assist',
  });
  const added = await api.post<{ questions: { id: number }[] }>(`/exams/${exam.id}/questions`, {
    sectionId: exam.sections[0].id,
    questionIds: [question.id],
    marks: 10,
  });
  await api.post(`/exams/${exam.id}/schedule`);

  await test.step('student answers the descriptive question and submits', async () => {
    const session = await loginWithPassword(http, student, newDevice('student'));
    const { attemptId } = await session.api.post<{ attemptId: number }>(`/exams/my/${exam.id}/start`);
    await session.api.put(`/exams/my/attempts/${attemptId}/answers/${added.questions[0].id}`, {
      response: { text: ANSWER },
    });
    await session.api.post(`/exams/my/attempts/${attemptId}/submit`);
  });

  await test.step('the grading job runs in the background with the mock provider', async () => {
    await expect
      .poll(
        async () =>
          (await api.get<{ status: string }[]>(`/exams/${exam.id}/grading-jobs`)).map((j) => j.status),
        { timeout: 60_000 },
      )
      .toEqual(['completed']);
  });

  await test.step('teacher reviews the AI suggestion and accepts it', async () => {
    const page = await openAs(institute.admin, `/exams/${exam.id}/evaluate`);
    const content = activePage(page);
    const jobs = content.locator('ion-card').filter({ hasText: 'AI grading jobs' });
    await expect(jobs).toContainText('completed');
    await expect(jobs).toContainText('1/1 processed');
    await expect(jobs).toContainText('mock · mock-ai-1');
    await expect(jobs.locator('ion-badge').filter({ hasText: 'simulated' })).toBeVisible();

    // The page opens on the "pending" filter; the graded answer waits under "ai suggested".
    await selectSegment(content, 'ai suggested');
    const answer = content.locator('ion-card').filter({ hasText: QUESTION });
    await expect(answer).toContainText(student.name);
    await expect(answer.locator('.response')).toHaveText(ANSWER);
    const ai = answer.locator('.ai');
    await expect(ai).toContainText('AI suggestion: 8.50 / 10');
    await expect(ai).toContainText('confidence 85%');
    await expect(ai.locator('ion-badge')).toHaveText('simulated');
    await expect(ai).toContainText(FEEDBACK);

    await answer.getByRole('button', { name: 'Accept AI' }).click();
    await expectToast(page, 'AI marks accepted');
    await selectSegment(content, 'finalized');
    await expect(answer).toContainText('Final: 8.50');
  });

  const evaluations = await api.get<{ finalMarks: number | null; aiMarks: number | null }[]>(
    `/exams/${exam.id}/evaluations`,
  );
  expect(evaluations).toEqual([expect.objectContaining({ aiMarks: 8.5, finalMarks: 8.5 })]);
});
