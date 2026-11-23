import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QuestionImportDto } from '@erp/shared';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';
import { buildQuestionPaperPdf, samplePaperPdf } from './fixtures/question-paper-pdf';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { FileObject } from '../src/modules/files/file.model';
import { AiUsage } from '../src/modules/ai/models';
import { tokensUsedThisMonth } from '../src/modules/ai/ai.service';
import { getActiveSubscription } from '../src/modules/subscriptions/subscription.service';
import { MOCK_FAILURE_MARKER } from '../src/infrastructure/ai-providers/mock.client';
import { QuestionImport } from '../src/modules/question-bank/models';
import {
  applyAnswer,
  applyAnswerKey,
  toPendingDraft,
  type StoredDraft,
} from '../src/modules/question-bank/pdf-import.extract';
import type { QuestionInput } from '@erp/shared';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
const BYPASS = { tenantBypass: true } as object;

describe('question paper PDF import: answer parsing', () => {
  const q = (type: QuestionInput['type'], options?: string[]): QuestionInput => ({
    type,
    text: 'x',
    options: options?.map((key) => ({ key, text: key })),
    answerKey: {},
  });

  it('understands answers as printed on papers', () => {
    const mcq = q('single', ['A', 'B', 'C', 'D']);
    expect(applyAnswer(mcq, '(a) and (c)')).toBe(true);
    expect(mcq).toMatchObject({ type: 'multiple', answerKey: { options: ['A', 'C'] } });
    expect(applyAnswer(q('single', ['A', 'B']), 'E')).toBe(false);

    const num = q('numerical');
    expect(applyAnswer(num, '9.8 ± 0.1')).toBe(true);
    expect(num.answerKey).toEqual({ value: 9.8, tolerance: 0.1 });
    expect(applyAnswer(num, '4 to 6')).toBe(true);
    expect(num.answerKey).toEqual({ min: 4, max: 6 });
    expect(applyAnswer(num, '2.5 A')).toBe(true);
    expect(num.answerKey).toEqual({ value: 2.5, tolerance: 0 });
    expect(applyAnswer(q('numerical'), 'about two')).toBe(false);

    const tf = q('true_false');
    expect(applyAnswer(tf, 'F')).toBe(true);
    expect(tf.answerKey).toEqual({ value: false });
    expect(applyAnswer(q('single', ['A', 'B']), null)).toBe(false);
  });

  it('does not map answer-key entries to question numbers that appear twice', () => {
    const drafts: StoredDraft[] = [
      toPendingDraft({ number: '1', text: 'a', options: ['x', 'y'] }, 1, 0),
      toPendingDraft({ number: 'Q1.', text: 'b', options: ['x', 'y'] }, 2, 0),
      toPendingDraft({ number: '2', text: 'c', options: ['x', 'y'] }, 2, 1),
    ];
    applyAnswerKey(drafts, [
      { number: '1', answer: 'A' },
      { number: '2', answer: 'B' },
    ]);
    expect(drafts.map((d) => d.answered)).toEqual([false, false, true]);
    expect(drafts[2].question.answerKey).toEqual({ options: ['B'] });
  });
});

describe('question paper PDF import', () => {
  let app: Express;
  let teacher: string;
  let branchAdmin: string;
  let student: string;
  let zenith: string;
  let bankId: number;

  const upload = (
    token: string,
    paper: Buffer | null,
    opts: { name?: string; answerKey?: Buffer; bank?: number } = {},
  ) => {
    let req = request(app)
      .post(`/api/question-bank/banks/${opts.bank ?? bankId}/pdf-imports`)
      .set(bearer(token));
    if (paper)
      req = req.attach('file', paper, { filename: opts.name ?? 'paper.pdf', contentType: 'application/pdf' });
    if (opts.answerKey)
      req = req.attach('answerKey', opts.answerKey, { filename: 'key.pdf', contentType: 'application/pdf' });
    return req;
  };
  const get = async (id: number, token = teacher) =>
    (await request(app).get(`/api/question-bank/pdf-imports/${id}`).set(bearer(token)))
      .body as QuestionImportDto;
  async function importAndWait(paper: Buffer, answerKey?: Buffer) {
    const res = await upload(teacher, paper, { answerKey });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'queued', pagesDone: 0 });
    await processDueJobs();
    return get(res.body.id);
  }

  let savedOverrides: unknown;
  async function setLimits(overrides: Record<string, unknown> | null) {
    const sub = (await getActiveSubscription(1))!;
    await sub.update({
      limitOverrides: overrides
        ? { ...((savedOverrides as Record<string, unknown> | null) ?? {}), ...overrides }
        : (savedOverrides as never),
    });
  }

  beforeAll(async () => {
    app = await getApp();
    [teacher, branchAdmin, student, zenith] = await Promise.all(
      [USERS.apexTeacher, USERS.apexBranchAdmin, STUDENT, USERS.zenithAdmin].map(
        async (u) => (await login(u)).accessToken,
      ),
    );
    const bank = await request(app)
      .post('/api/question-bank/banks')
      .set(bearer(teacher))
      .send({ name: 'PDF import bank', visibility: 'private' });
    expect(bank.status).toBe(201);
    bankId = bank.body.id;
    savedOverrides = (await getActiveSubscription(1))!.limitOverrides;
  });
  afterAll(async () => {
    await setLimits(null);
  });

  it('reads a question paper in the background into reviewable drafts with answers from its answer key', async () => {
    const usageBefore = await AiUsage.count({ where: { feature: 'question-bank.pdf-import' }, ...BYPASS });
    const imp = await importAndWait(samplePaperPdf());
    expect(imp).toMatchObject({ status: 'ready', pageCount: 2, pagesDone: 2, error: null, warnings: [] });
    expect(imp.model).toBeTruthy();
    // Page 1 has a picture, page 2 little text: both go to the vision model with a page image.
    expect(imp.visionPages).toBe(2);
    const usage = await AiUsage.findAll({
      where: { feature: 'question-bank.pdf-import' },
      order: [['id', 'DESC']],
      limit: 2,
      ...BYPASS,
    });
    expect(usage.every((u) => u.imageCount === 1)).toBe(true);
    expect(await AiUsage.count({ where: { feature: 'question-bank.pdf-import' }, ...BYPASS })).toBe(
      usageBefore + 2,
    );

    const [q1, q2, q3, q4, q5] = imp.drafts;
    expect(imp.drafts.map((d) => d.number)).toEqual(['1', '2', '3', '4', '5']);
    expect(q1).toMatchObject({
      page: 1,
      flags: [],
      problem: null,
      question: {
        type: 'single',
        text: 'What is the SI unit of force?',
        answerKey: { options: ['A'] },
        source: 'import',
      },
    });
    expect(q1.question.options).toEqual([
      { key: 'A', text: 'Newton' },
      { key: 'B', text: 'Joule' },
      { key: 'C', text: 'Watt' },
      { key: 'D', text: 'Pascal' },
    ]);
    expect(q2.question).toMatchObject({ type: 'multiple', answerKey: { options: ['A', 'C'] } });
    expect(q3.question).toMatchObject({ type: 'numerical', answerKey: { value: 2.5, tolerance: 0 } });
    expect(q3.flags).toEqual(['has_diagram']);
    expect(q3.diagrams).toHaveLength(1);
    const diagram = await request(app).get(new URL(q3.diagrams[0].url).pathname);
    expect(diagram.status).toBe(200);
    expect(diagram.headers['content-type']).toContain('image/png');
    expect(q4).toMatchObject({ page: 2, question: { type: 'true_false', answerKey: { value: false } } });
    // No answer printed for Q5: left empty and flagged, never guessed.
    expect(q5.question).toMatchObject({ type: 'descriptive', answerKey: {} });
    expect(q5.flags).toEqual(['answer_missing']);

    // Nothing is in the bank until the teacher saves.
    const before = await request(app)
      .get(`/api/question-bank/questions?bankId=${bankId}`)
      .set(bearer(teacher));
    expect(before.body.total ?? before.body.items?.length).toBe(0);

    const listed = await request(app)
      .get(`/api/question-bank/banks/${bankId}/pdf-imports`)
      .set(bearer(teacher));
    expect(listed.body.map((i: QuestionImportDto) => i.id)).toContain(imp.id);

    const saved = await request(app)
      .post(`/api/question-bank/pdf-imports/${imp.id}/save`)
      .set(bearer(teacher))
      .send({
        items: [
          { draftId: q1.id, question: { ...q1.question, difficulty: 'easy', defaultMarks: 2 } },
          { draftId: q3.id, question: { ...q3.question, text: 'Find the current (in A).' } },
        ],
      });
    expect(saved.status).toBe(201);
    expect(saved.body.created).toBe(2);
    const [savedQ1, savedQ3] = await Promise.all(
      saved.body.questionIds.map(
        async (id: number) =>
          (await request(app).get(`/api/question-bank/questions/${id}`).set(bearer(teacher))).body,
      ),
    );
    expect(savedQ1).toMatchObject({
      source: 'import',
      difficulty: 'easy',
      defaultMarks: 2,
      answerKey: { options: ['A'] },
    });
    expect(savedQ3).toMatchObject({ text: 'Find the current (in A).', answerKey: { value: 2.5 } });
    expect(savedQ3.assets).toHaveLength(1);
    expect(savedQ3.assets[0].fileId).toBe(q3.diagrams[0].fileId);

    const after = await get(imp.id);
    expect(after).toMatchObject({ status: 'saved', savedCount: 2, fileUrl: null, drafts: [] });
    // The uploaded paper is removed once the questions are saved.
    const row = await QuestionImport.findByPk(imp.id, BYPASS);
    expect(row!.fileId).toBeNull();
    const again = await request(app)
      .post(`/api/question-bank/pdf-imports/${imp.id}/save`)
      .set(bearer(teacher))
      .send({ items: [{ draftId: q4.id, question: q4.question }] });
    expect(again.status).toBe(409);
  });

  it('joins questions across pages and flags answers that disagree with a separate answer key', async () => {
    const paper = buildQuestionPaperPdf([
      { lines: ['1. Capital of France?', '(A) Paris (B) Rome', 'Ans: A', '2. Which gas is a noble gas?'] },
      { lines: ['(A) Neon (B) Oxygen'] },
      { lines: [`3. Name the process plants use to make food. ${MOCK_FAILURE_MARKER}`] },
    ]);
    const key = buildQuestionPaperPdf([{ lines: ['Answer Key', '1-B 2-A'] }]);
    const imp = await importAndWait(paper, key);
    expect(imp).toMatchObject({ status: 'ready', pageCount: 4, pagesDone: 4, answerKeyFileName: 'key.pdf' });
    expect(imp.drafts).toHaveLength(2);
    const [q1, q2] = imp.drafts;
    expect(q1.question.answerKey).toEqual({ options: ['A'] });
    expect(q1.flags).toContain('answer_conflict');
    expect(q2.question).toMatchObject({ type: 'single', answerKey: { options: ['A'] } });
    expect(q2.question.options).toHaveLength(2);
    expect(q2.flags).toEqual(['spans_pages']);
    expect(imp.warnings).toEqual([expect.stringMatching(/^Page 3 could not be read/)]);

    const bad = await request(app)
      .post(`/api/question-bank/pdf-imports/${imp.id}/save`)
      .set(bearer(teacher))
      .send({ items: [{ draftId: 'nope', question: q1.question }] });
    expect(bad.status).toBe(400);

    const discarded = await request(app)
      .delete(`/api/question-bank/pdf-imports/${imp.id}`)
      .set(bearer(teacher));
    expect(discarded.status).toBe(204);
    const row = await QuestionImport.findByPk(imp.id, BYPASS);
    expect(row).toMatchObject({ status: 'discarded', fileId: null, answerKeyFileId: null });
    const listed = await request(app)
      .get(`/api/question-bank/banks/${bankId}/pdf-imports`)
      .set(bearer(teacher));
    expect(listed.body.map((i: QuestionImportDto) => i.id)).not.toContain(imp.id);
  });

  it('reports scanned pages it could not read instead of inventing questions', async () => {
    const imp = await importAndWait(buildQuestionPaperPdf([{ images: [{ x: 0, y: 0, w: 595, h: 842 }] }]));
    expect(imp).toMatchObject({ status: 'ready', visionPages: 1, drafts: [] });
    expect(imp.warnings).toEqual(['Page 1: no questions found (scanned page; check it was read correctly)']);
  });

  it('rejects files that are not readable PDFs, too long or too large', async () => {
    const filesBefore = await FileObject.count(BYPASS);
    const notPdf = await upload(teacher, Buffer.from('just some text'), { name: 'notes.pdf' });
    expect(notPdf.status).toBe(400);
    expect(notPdf.body.error.code).toBe('NOT_A_PDF');
    const broken = await upload(teacher, Buffer.from('%PDF-1.7\nbroken'));
    expect(broken.body.error.code).toBe('PDF_UNREADABLE');
    const long = await upload(
      teacher,
      buildQuestionPaperPdf(Array.from({ length: 31 }, () => ({ lines: ['x'] }))),
    );
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('PDF_TOO_MANY_PAGES');
    const big = await upload(teacher, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(21 * 1048576)]));
    expect(big.status).toBe(413);
    const missing = await upload(teacher, null);
    expect(missing.status).toBe(400);
    expect(await FileObject.count(BYPASS)).toBe(filesBefore);
  });

  it('is limited to staff who can edit the bank, within their institute', async () => {
    expect((await upload(student, samplePaperPdf())).status).toBe(403);
    expect((await upload(zenith, samplePaperPdf())).status).toBe(404);
    const res = await upload(teacher, samplePaperPdf());
    expect(res.status).toBe(202);
    await processDueJobs();
    expect(
      (await request(app).get(`/api/question-bank/pdf-imports/${res.body.id}`).set(bearer(zenith))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/question-bank/pdf-imports/${res.body.id}`).set(bearer(student))).status,
    ).toBe(403);
    // Managers can see the teacher's import (bank is private to the teacher but managers see all banks).
    expect((await get(res.body.id, branchAdmin)).status).toBe('ready');
    expect(
      (await request(app).delete(`/api/question-bank/pdf-imports/${res.body.id}`).set(bearer(teacher)))
        .status,
    ).toBe(204);
  });

  it('respects the AI quota before and during reading', async () => {
    try {
      const used = await tokensUsedThisMonth(1);
      await setLimits({ aiTokensMonthly: used });
      const refused = await upload(teacher, samplePaperPdf());
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('AI_QUOTA_EXCEEDED');

      // Room for one page: the rest is skipped but what was read stays reviewable.
      await setLimits({ aiTokensMonthly: used + 1 });
      const res = await upload(teacher, samplePaperPdf());
      expect(res.status).toBe(202);
      await processDueJobs();
      const imp = await get(res.body.id);
      expect(imp).toMatchObject({ status: 'ready', pagesDone: 1 });
      expect(imp.drafts).toHaveLength(3);
      expect(imp.drafts.every((d) => d.flags.includes('answer_missing'))).toBe(true);
      expect(imp.warnings).toEqual([expect.stringMatching(/^Page 2 and later pages were not read/)]);
    } finally {
      await setLimits(null);
    }
  });
});
