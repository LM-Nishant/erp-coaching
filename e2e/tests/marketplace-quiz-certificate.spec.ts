/**
 * Course marketplace (wave 2): quiz → certificate.
 *
 * Setup (API): an independent instructor creates a free course with one article lecture.
 * Browser (instructor): adds a quiz lecture in the course builder and writes two questions (one answer and several
 * answers) with an explanation. The course is then submitted and approved (API).
 * Browser (learner): reads the article, fails the quiz (the lecture stays open, progress 50%), sees the correct
 * answers and explanation, retakes and passes it: progress 100% and a certificate. My learning lists the
 * certificate, and anyone can open its public verification page.
 */
import { expect, test } from '../support/fixtures';
import { Api, loginWithPassword, newDevice } from '../support/api';
import { API_URL } from '../support/env';
import { PASSWORD, uniqueId } from '../support/data';
import { activePage, chooseOption, modal } from '../support/ui';

let lastMobile = 0;
/** Test mobiles in the 966… range used by the quiz and certificate spec. */
function quizMobile(): string {
  lastMobile = Math.max(lastMobile + 1, Math.floor(Date.now() / 100));
  return `966${String(lastMobile % 10_000_000).padStart(7, '0')}`;
}

interface Media {
  id: number;
  status: string;
}

async function account(http: Parameters<typeof loginWithPassword>[0], name: string, label: string) {
  const mobile = quizMobile();
  await new Api(http).post('/marketplace/public/signup', { name, mobile, password: PASSWORD });
  return loginWithPassword(http, { mobile, password: PASSWORD }, newDevice(label));
}

test('build a quiz → fail and pass it → certificate and public verification', async ({
  http,
  superAdmin,
  openAs,
}) => {
  const tag = uniqueId();
  const title = `Kitchen science ${tag}`;
  const base = '/marketplace/instructor';
  const instructor = await account(http, 'Ravi Chef', 'quiz-instructor');

  const courseId = await test.step('an instructor drafts a free course', async () => {
    const { api } = instructor;
    await api.put('/marketplace/instructor-profile', { displayName: `Ravi Chef ${tag}`, headline: 'Cook' });
    const categories = await superAdmin.api.post<{ id: number; name: string }[]>(
      '/admin/marketplace/categories',
      { name: `Cooking ${tag}` },
    );
    const category = categories.find((c) => c.name === `Cooking ${tag}`)!;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const started = await api.post<Media>(`${base}/media`, {
      kind: 'image',
      name: 'cover.png',
      mimeType: 'image/png',
      sizeBytes: png.length,
    });
    const put = await http.fetch(`${API_URL}/api${base}/media/${started.id}/content?offset=0`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${instructor.accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      data: png,
    });
    expect(put.ok(), await put.text()).toBe(true);
    await expect.poll(async () => (await api.get<Media>(`${base}/media/${started.id}`)).status).toBe('ready');
    const course = await api.post<{ id: number }>(`${base}/courses`, {
      title,
      subtitle: 'Why food does what it does',
      description: 'Short lessons on the science behind everyday cooking, from boiling points to browning.',
      categoryId: category.id,
      pricePaise: 0,
      outcomes: ['Explain boiling and browning', 'Cook with confidence'],
      thumbnailMediaId: started.id,
    });
    const withSection = await api.post<{ sections: { id: number }[] }>(
      `${base}/courses/${course.id}/sections`,
      {
        title: 'Heat',
      },
    );
    await api.post(`${base}/courses/${course.id}/sections/${withSection.sections.at(-1)!.id}/lectures`, {
      title: 'Boiling explained',
      type: 'article',
      articleBody: 'Water boils at 100 °C at sea level.',
    });
    return course.id;
  });

  await test.step('the instructor adds a quiz lecture with two questions in the builder', async () => {
    const page = await openAs(instructor, `/market/studio/instructor/courses/${courseId}?tab=curriculum`);
    await activePage(page).getByTestId('add-lecture-0').click();
    const editor = modal(page);
    await editor.getByTestId('lecture-title-input').locator('input').fill('Heat check');
    await chooseOption(editor.locator('ion-select').filter({ hasText: 'Type' }), 'Quiz');
    await expect(editor.getByTestId('lecture-preview')).toHaveCount(0);
    await editor.getByTestId('lecture-save').click();

    // A new quiz opens straight into its question editor, with one blank question.
    const quiz = modal(page);
    await expect(quiz.getByText('Quiz: Heat check')).toBeVisible();
    await quiz
      .getByTestId('quiz-prompt-0')
      .locator('textarea')
      .fill('At what temperature does water boil at sea level?');
    for (const [i, text] of ['90 °C', '100 °C', '120 °C', '150 °C'].entries())
      await quiz.getByTestId(`quiz-option-0-${i}`).locator('input').fill(text);
    await quiz.getByTestId('quiz-correct-0-1').click();
    await quiz.getByTestId('quiz-explanation-0').locator('textarea').fill('At 1 atm water boils at 100 °C.');

    await quiz.getByTestId('quiz-add-question').click();
    await quiz.getByTestId('quiz-kind-multi-1').click();
    await quiz.getByTestId('quiz-prompt-1').locator('textarea').fill('Which of these speed up browning?');
    for (const [i, text] of ['Dry surface', 'High heat', 'Steaming', 'Crowding the pan'].entries())
      await quiz.getByTestId(`quiz-option-1-${i}`).locator('input').fill(text);
    await quiz.getByTestId('quiz-correct-1-0').click();
    await quiz.getByTestId('quiz-correct-1-1').click();
    await expect(quiz.getByTestId('quiz-problem')).toHaveCount(0);
    await quiz.getByTestId('quiz-save').click();
    await expect(page.locator('ion-toast').filter({ hasText: 'Quiz saved' }).last()).toBeVisible();
    await quiz.getByRole('button', { name: 'Close' }).click();
    await expect(activePage(page).getByText('Heat check')).toBeVisible();

    await instructor.api.post(`${base}/courses/${courseId}/submit`);
    const approved = await superAdmin.api.post<{ status: string }>(
      `/admin/marketplace/courses/${courseId}/approve`,
      {},
    );
    expect(approved.status).toBe('published');
  });

  const learner = await account(http, 'Nisha Learner', 'quiz-learner');
  await learner.api.post(`/marketplace/courses/${courseId}/enrol`);

  const page = await openAs(learner, `/market/learn/${courseId}`);
  await test.step('the learner reads the article and fails the quiz first', async () => {
    const player = activePage(page);
    await expect(player.getByTestId('lecture-title')).toHaveText('Boiling explained');
    await player.getByTestId('mark-complete').click();
    await expect(player.getByTestId('course-progress')).toContainText('50%');

    await player.getByText('Heat check').first().click();
    await expect(player.getByTestId('quiz-player')).toBeVisible();
    await expect(player.getByTestId('mark-complete')).toHaveCount(0);
    const questions = player.locator('[data-testid^="quiz-q-"]');
    await questions.nth(0).getByText('100 °C').click();
    await questions.nth(1).getByText('Dry surface').click();
    await player.getByTestId('quiz-submit').click();
    await expect(player.getByTestId('quiz-result')).toContainText('Not passed yet');
    await expect(player.getByTestId('quiz-score')).toHaveText('50%');
    await expect(player.getByText('At 1 atm water boils at 100 °C.')).toBeVisible();
    await expect(player.getByTestId('course-progress')).toContainText('50%');
  });

  await test.step('they retake it, pass, and get a certificate', async () => {
    const player = activePage(page);
    await player.getByTestId('quiz-retake').click();
    const questions = player.locator('[data-testid^="quiz-q-"]');
    await questions.nth(0).getByText('100 °C').click();
    await questions.nth(1).getByText('Dry surface').click();
    await questions.nth(1).getByText('High heat').click();
    await player.getByTestId('quiz-submit').click();
    await expect(player.getByTestId('quiz-result')).toContainText('Passed');
    await expect(player.getByTestId('course-progress')).toContainText('100%');
    await expect(player.getByTestId('certificate-banner')).toBeVisible();
  });

  const code = await test.step('My learning lists the certificate', async () => {
    await page.goto('/market/learning');
    const list = activePage(page).getByTestId('my-certificates');
    await expect(list).toContainText(title);
    const text = (await list
      .locator('[data-testid^="certificate-MKT-"]')
      .first()
      .getAttribute('data-testid'))!;
    return text.replace('certificate-', '');
  });

  await test.step('anyone can verify it on the public page', async () => {
    const visitor = await openAs(null, `/market/certificates/${code}`);
    const view = activePage(visitor);
    await expect(view.getByTestId('certificate-valid')).toBeVisible();
    await expect(view.getByTestId('certificate-learner')).toHaveText('Nisha Learner');
    await expect(view.getByTestId('certificate-course')).toContainText(title);
    await expect(view.getByTestId('certificate-code')).toHaveText(code);
    const pdf = await http.get(`${API_URL}/api/marketplace/public/certificates/${code}/pdf`);
    expect(pdf.headers()['content-type']).toBe('application/pdf');

    await visitor.goto('/market/certificates/MKT-AAAAAAAAAA');
    await expect(activePage(visitor).getByTestId('certificate-invalid')).toBeVisible();
  });
});
