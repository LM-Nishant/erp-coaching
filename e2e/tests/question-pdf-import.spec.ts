/**
 * Question bank: import an existing question paper from a PDF with the mock AI provider.
 *
 * Setup (API): the super admin selects the built-in mock AI provider (deterministic, no network);
 * a new institute with an empty question bank. Browser: the institute admin opens the bank, taps
 * "Import PDF paper" and uploads a two-page paper (MCQs, a numerical question with a diagram, a
 * true/false and a descriptive question, with the answer key on the last page). The paper is read
 * in the background; the review screen shows the five drafts, flags the descriptive question that
 * has no printed answer, and lets the teacher edit and pick drafts. Only the picked drafts are saved.
 *
 * Set E2E_SCREENSHOT_DIR to also save desktop and mobile screenshots of the three screens.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, signedInState, test } from '../support/fixtures';
import { createInstitute } from '../support/data';
import { activePage, chooseOption, expectToast } from '../support/ui';
import { samplePaperPdf } from '../../backend/test/fixtures/question-paper-pdf';

const PAPER = { name: 'physics-unit-test.pdf', mimeType: 'application/pdf', buffer: samplePaperPdf() };
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR;

async function snap(page: Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() =>
    document
      .querySelectorAll('ion-content')
      .forEach(
        (c) => void (c as HTMLElement & { scrollToTop: (ms: number) => Promise<void> }).scrollToTop(0),
      ),
  );
  await page.waitForTimeout(400); // let Ionic transitions settle
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

const draftCard = (content: Locator, n: string) =>
  content.locator('ion-card').filter({ has: content.page().locator(`strong:text-is("Q${n}")`) });

async function uploadPaper(page: Page): Promise<Locator> {
  const content = activePage(page);
  await content.getByTestId('import-pdf').click();
  const upload = activePage(page);
  await expect(upload.getByTestId('pick-paper')).toBeVisible();
  await upload.getByTestId('paper-input').setInputFiles(PAPER);
  await expect(upload.getByTestId('pick-paper')).toContainText(PAPER.name);
  return upload;
}

test('import a question paper PDF → review, edit and save the picked questions', async ({
  browser,
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
  const institute = await createInstitute(http, superAdmin, 'pdfimp');
  const { api } = institute.admin;
  const bank = await api.post<{ id: number }>('/question-bank/banks', { name: 'Physics papers' });

  const page = await openAs(institute.admin, `/question-bank/banks/${bank.id}`);
  if (SCREENSHOT_DIR) await page.setViewportSize({ width: 1280, height: 1000 });
  let content = await uploadPaper(page);
  await snap(page, 'desktop-1-upload');

  await test.step('the paper is read in the background and the drafts appear for review', async () => {
    await content.getByTestId('start-import').click();
    await expect(content.getByText(/5 question\(s\) found in/)).toBeVisible({ timeout: 60_000 });
    await expect(content.locator('ion-card[data-testid^="draft-"]')).toHaveCount(5);

    const q1 = draftCard(content, '1');
    await expect(q1.locator('ion-textarea').first()).toHaveJSProperty(
      'value',
      'What is the SI unit of force?',
    );
    await expect(q1.getByTestId(/correct-.*-A/).first()).toHaveJSProperty('checked', true);

    const q3 = draftCard(content, '3');
    await expect(q3.locator('ion-badge')).toHaveText(['Has a diagram']);
    await expect(q3.locator('.diagrams img')).toHaveCount(1);
    await expect(q3.locator('ion-input[data-testid^="num-"]')).toHaveJSProperty('value', '2.5');

    // The descriptive question has no printed answer: flagged and not pre-selected.
    const q5 = draftCard(content, '5');
    await expect(q5.locator('ion-badge')).toHaveText(['Answer not found: set it']);
    await expect(q5.locator('ion-checkbox[data-testid^="select-"]')).toHaveJSProperty('checked', false);
    await content.getByTestId('filter-attention').click();
    await expect(content.locator('ion-card[data-testid^="draft-"]')).toHaveCount(1);
    await content.locator('ion-segment-button').filter({ hasText: 'All (5)' }).click();
  });

  await test.step('the teacher edits, picks and saves', async () => {
    await chooseOption(content.locator('ion-select').filter({ hasText: 'Difficulty' }), 'hard');
    const q1Text = draftCard(content, '1').locator('ion-textarea').first().locator('textarea');
    await q1Text.fill('What is the SI unit of force? (1 mark)');
    // Fill in the missing model answer for Q5 and pick it; leave Q4 out.
    const q5 = draftCard(content, '5');
    await q5.locator('ion-textarea').filter({ hasText: 'Model answer' }).locator('textarea').fill('F = ma');
    await q5.locator('ion-checkbox[data-testid^="select-"]').click();
    await draftCard(content, '4').locator('ion-checkbox[data-testid^="select-"]').click();
    await expect(content.getByTestId('save-selected')).toContainText('Save 4 selected');
    await snap(page, 'desktop-2-review');

    await content.getByTestId('save-selected').click();
    await expectToast(page, '4 question(s) added to the bank');
    content = activePage(page);
    await expect(content.getByText('What is the SI unit of force? (1 mark)')).toBeVisible();
    await expect(content.getByText('4 question(s) match the current filters.')).toBeVisible();
    await snap(page, 'desktop-3-saved');
  });

  const saved = await api.get<{
    items: { text: string; difficulty: string; source: string; answerKey: object; assets: unknown[] }[];
  }>(`/question-bank/questions?bankId=${bank.id}&pageSize=50`);
  expect(saved.items.map((q) => q.text).sort()).toEqual(
    [
      'In the circuit shown, find the current through the 4 ohm resistor (in A).',
      "State Newton's second law of motion.",
      'What is the SI unit of force? (1 mark)',
      'Which of these are vector quantities?',
    ].sort(),
  );
  expect(saved.items.every((q) => q.difficulty === 'hard' && q.source === 'import')).toBe(true);
  const q3 = saved.items.find((q) => q.text.startsWith('In the circuit'));
  expect(q3?.assets).toHaveLength(1);
  expect(q3?.answerKey).toEqual({ value: 2.5, tolerance: 0 });

  if (SCREENSHOT_DIR) {
    await test.step('mobile screenshots', async () => {
      const context = await browser.newContext({
        storageState: signedInState(institute.admin),
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const mobile = await context.newPage();
      await mobile.goto(`/question-bank/banks/${bank.id}`);
      const upload = await uploadPaper(mobile);
      await snap(mobile, 'mobile-1-upload');
      await upload.getByTestId('start-import').click();
      await expect(upload.getByText(/5 question\(s\) found in/)).toBeVisible({ timeout: 60_000 });
      await snap(mobile, 'mobile-2-review');
      await upload.getByTestId('save-selected').click();
      await expectToast(mobile, 'question(s) added to the bank');
      await expect(activePage(mobile).getByText('question(s) match the current filters.')).toBeVisible();
      await snap(mobile, 'mobile-3-saved');
      await context.close();
    });
  }
});
