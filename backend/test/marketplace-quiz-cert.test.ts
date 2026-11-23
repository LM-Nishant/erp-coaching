import request from 'supertest';
import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { MktCertificate } from '../src/modules/marketplace/quiz-models';
import { DEMO_PASSWORD, USERS, bearer, getApp, login } from './helpers';

/** Test mobiles start with 966. */
let seq = 0;
const mobile = () => `96612${String(seq++).padStart(5, '0')}`;

let app: Express;
let admin: string;

async function newAccount(name: string) {
  const m = mobile();
  const res = await request(app)
    .post('/api/marketplace/public/signup')
    .send({ name, mobile: m, password: DEMO_PASSWORD });
  expect(res.status).toBe(201);
  return (await login({ mobile: m, password: DEMO_PASSWORD })).accessToken;
}

async function newInstructor(name: string) {
  const token = await newAccount(name);
  const profile = await request(app)
    .put('/api/marketplace/instructor-profile')
    .set(bearer(token))
    .send({ displayName: name, headline: 'Teaches things' });
  expect(profile.status).toBe(200);
  return token;
}

async function thumbnail(token: string, base: string) {
  const data = Buffer.from('\x89PNG fake');
  const start = await request(app)
    .post(`${base}/media`)
    .set(bearer(token))
    .send({ kind: 'image', name: 'x.png', mimeType: 'image/png', sizeBytes: data.length });
  expect(start.status).toBe(201);
  await request(app)
    .put(`${base}/media/${start.body.id}/content?offset=0`)
    .set(bearer(token))
    .set('content-type', 'application/octet-stream')
    .send(data);
  await processDueJobs();
  return start.body.id as number;
}

const QUIZ = {
  passPercent: 50,
  maxAttempts: 3,
  questions: [
    {
      kind: 'single',
      prompt: '2 + 2 = ?',
      options: [
        { key: 'A', text: '3' },
        { key: 'B', text: '4' },
      ],
      correct: ['B'],
      explanation: 'Basic addition.',
    },
    {
      kind: 'multi',
      prompt: 'Which are even?',
      options: [
        { key: 'A', text: '2' },
        { key: 'B', text: '3' },
        { key: 'C', text: '4' },
      ],
      correct: ['A', 'C'],
    },
  ],
};

/** A free course with one article and one quiz lecture, published; returns ids. */
async function quizCourse(token: string, base: string, quiz: object = QUIZ) {
  const cats = await request(app).get('/api/marketplace/public/categories');
  const created = await request(app)
    .post(`${base}/courses`)
    .set(bearer(token))
    .send({
      title: `Quiz course ${mobile()}`,
      subtitle: 'A short subtitle',
      description: 'A description that is comfortably longer than fifty characters in total.',
      categoryId: cats.body[0].id,
      pricePaise: 0,
      outcomes: ['One thing', 'Another thing'],
      thumbnailMediaId: await thumbnail(token, base),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
  const section = await request(app)
    .post(`${base}/courses/${id}/sections`)
    .set(bearer(token))
    .send({ title: 'Intro' });
  const sectionId = section.body.sections.at(-1).id as number;
  const add = (l: object) =>
    request(app).post(`${base}/courses/${id}/sections/${sectionId}/lectures`).set(bearer(token)).send(l);
  expect((await add({ title: 'Read me', type: 'article', articleBody: 'Hello learners' })).status).toBe(201);
  const q = await add({ title: 'Check yourself', type: 'quiz', preview: true });
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  const lectures = q.body.sections.at(-1).lectures as { id: number; type: string; preview: boolean }[];
  const articleId = lectures.find((l) => l.type === 'article')!.id;
  const quizLecture = lectures.find((l) => l.type === 'quiz')!;
  expect(quizLecture.preview).toBe(false);
  const quizId = quizLecture.id;

  // an empty quiz blocks review
  const ready = await request(app).get(`${base}/courses/${id}/readiness`).set(bearer(token));
  expect(ready.body.issues).toContain('Add questions to the quiz "Check yourself"');

  const saved = await request(app)
    .put(`${base}/courses/${id}/lectures/${quizId}/quiz`)
    .set(bearer(token))
    .send(quiz);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  expect((await request(app).post(`${base}/courses/${id}/submit`).set(bearer(token))).status).toBe(200);
  const approve = await request(app)
    .post(`/api/admin/marketplace/courses/${id}/approve`)
    .set(bearer(admin))
    .send({});
  expect(approve.body.status).toBe('published');
  return { id, articleId, quizId };
}

beforeAll(async () => {
  app = await getApp();
  admin = (await login(USERS.superAdmin)).accessToken;
});

describe('quiz builder', () => {
  it('validates questions and keeps answers to the seller and reviewer', async () => {
    const seller = await newInstructor('Quiz Seller');
    const base = '/api/marketplace/instructor';
    const { id, quizId } = await quizCourse(seller, base);

    const bad = (body: object) =>
      request(app).put(`${base}/courses/${id}/lectures/${quizId}/quiz`).set(bearer(seller)).send(body);
    const one = QUIZ.questions[0]!;
    expect((await bad({ passPercent: 0, questions: [one] })).status).toBe(422);
    expect((await bad({ passPercent: 50, questions: [{ ...one, correct: ['A', 'B'] }] })).status).toBe(400);
    expect((await bad({ passPercent: 50, questions: [{ ...one, correct: ['Z'] }] })).status).toBe(400);

    const own = await request(app).get(`${base}/courses/${id}/lectures/${quizId}/quiz`).set(bearer(seller));
    expect(own.body).toMatchObject({ passPercent: 50, maxAttempts: 3 });
    expect(own.body.questions[1].correct).toEqual(['A', 'C']);

    const review = await request(app)
      .get(`/api/admin/marketplace/courses/${id}/lectures/${quizId}/quiz`)
      .set(bearer(admin));
    expect(review.body.questions).toHaveLength(2);

    // another seller can't read it
    const other = await newInstructor('Other Seller');
    expect(
      (await request(app).get(`${base}/courses/${id}/lectures/${quizId}/quiz`).set(bearer(other))).status,
    ).toBe(404);
  });

  it('imports multiple-choice and true/false questions from the institute question bank', async () => {
    const apex = (await login(USERS.apexAdmin)).accessToken;
    const bank = await request(app)
      .post('/api/question-bank/banks')
      .set(bearer(apex))
      .send({ name: `Marketplace quiz ${mobile()}`, visibility: 'shared' });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const addQ = async (body: object) => {
      const r = await request(app)
        .post(`/api/question-bank/banks/${bank.body.id}/questions`)
        .set(bearer(apex))
        .send({ difficulty: 'easy', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as number;
    };
    const mcq = await addQ({
      type: 'multiple',
      text: 'Pick the primes',
      options: [
        { key: 'a', text: '2' },
        { key: 'b', text: '4' },
        { key: 'c', text: '5' },
      ],
      answerKey: { options: ['a', 'c'] },
      explanation: 'Primes have two divisors.',
    });
    const tf = await addQ({ type: 'true_false', text: 'The sky is blue', answerKey: { value: true } });
    const numeric = await addQ({ type: 'numerical', text: '6 x 7', answerKey: { value: 42 } });

    const base = '/api/marketplace/institute';
    const course = await request(app)
      .post(`${base}/courses`)
      .set(bearer(apex))
      .send({ title: `Institute quiz ${mobile()}` });
    expect(course.status, JSON.stringify(course.body)).toBe(201);
    const id = course.body.id as number;
    const section = await request(app)
      .post(`${base}/courses/${id}/sections`)
      .set(bearer(apex))
      .send({ title: 'Intro' });
    const lecture = await request(app)
      .post(`${base}/courses/${id}/sections/${section.body.sections.at(-1).id}/lectures`)
      .set(bearer(apex))
      .send({ title: 'Bank quiz', type: 'quiz' });
    const quizId = lecture.body.sections.at(-1).lectures.at(-1).id as number;
    const url = `${base}/courses/${id}/lectures/${quizId}/quiz/import`;

    expect(
      (
        await request(app)
          .post(url)
          .set(bearer(apex))
          .send({ questionIds: [numeric] })
      ).status,
    ).toBe(400);
    const imported = await request(app)
      .post(url)
      .set(bearer(apex))
      .send({ questionIds: [mcq, tf] });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body.questions).toMatchObject([
      {
        kind: 'multi',
        prompt: 'Pick the primes',
        correct: ['A', 'C'],
        explanation: 'Primes have two divisors.',
      },
      { kind: 'single', options: [{ text: 'True' }, { text: 'False' }], correct: ['A'] },
    ]);

    // another institute's admin can't import Apex's questions
    const zenith = (await login(USERS.zenithAdmin)).accessToken;
    expect(
      (
        await request(app)
          .post(url)
          .set(bearer(zenith))
          .send({ questionIds: [mcq] })
      ).status,
    ).toBe(404);
  });
});

describe('taking a quiz and earning a certificate', () => {
  it('grades on the server, completes only on a pass, limits attempts and issues a certificate', async () => {
    const seller = await newInstructor('Cert Seller');
    const base = '/api/marketplace/instructor';
    const { id, articleId, quizId } = await quizCourse(seller, base, { ...QUIZ, passPercent: 100 });

    const learner = await newAccount('Asha Learner');
    expect(
      (await request(app).post(`/api/marketplace/courses/${id}/enrol`).set(bearer(learner))).status,
    ).toBe(201);
    const quizUrl = `/api/marketplace/learning/${id}/lectures/${quizId}/quiz`;

    // the learner view has no answer key
    const view = await request(app).get(quizUrl).set(bearer(learner));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ passPercent: 100, maxAttempts: 3, attemptsUsed: 0, canAttempt: true });
    expect(JSON.stringify(view.body)).not.toMatch(/correct|explanation/);
    const [q1, q2] = view.body.questions as { id: number; prompt: string }[];
    const byPrompt = (p: string) => [q1!, q2!].find((q) => q.prompt === p)!.id;

    // a quiz can't be marked complete by hand
    const manual = await request(app)
      .put(`/api/marketplace/learning/${id}/lectures/${quizId}/progress`)
      .set(bearer(learner))
      .send({ completed: true });
    expect(manual.status).toBe(400);

    // half right: not passed, the lecture stays open
    const fail = await request(app)
      .post(`${quizUrl}/attempts`)
      .set(bearer(learner))
      .send({ answers: { [byPrompt('2 + 2 = ?')]: ['B'], [byPrompt('Which are even?')]: ['A'] } });
    expect(fail.status, JSON.stringify(fail.body)).toBe(201);
    expect(fail.body).toMatchObject({
      score: 1,
      total: 2,
      percent: 50,
      passed: false,
      certificateCode: null,
    });
    expect(fail.body.questions.find((q: { kind: string }) => q.kind === 'multi')).toMatchObject({
      isCorrect: false,
      chosen: ['A'],
      correct: ['A', 'C'],
    });
    const after = await request(app).get(`/api/marketplace/learning/${id}`).set(bearer(learner));
    expect(after.body.sections[0].lectures.find((l: { id: number }) => l.id === quizId).completed).toBe(
      false,
    );

    // article first, then pass the quiz: 100% and a certificate
    await request(app)
      .put(`/api/marketplace/learning/${id}/lectures/${articleId}/progress`)
      .set(bearer(learner))
      .send({ completed: true });
    const pass = await request(app)
      .post(`${quizUrl}/attempts`)
      .set(bearer(learner))
      .send({ answers: { [byPrompt('2 + 2 = ?')]: ['B'], [byPrompt('Which are even?')]: ['C', 'A'] } });
    expect(pass.body).toMatchObject({ percent: 100, passed: true, progressPercent: 100 });
    const code = pass.body.certificateCode as string;
    expect(code).toMatch(/^MKT-[A-HJ-NP-Z2-9]{10}$/);

    // past attempts are kept and readable; the third is the last one allowed
    const again = await request(app).get(quizUrl).set(bearer(learner));
    expect(again.body).toMatchObject({ attemptsUsed: 2, passed: true, bestPercent: 100, canAttempt: true });
    const old = await request(app).get(`${quizUrl}/attempts/${fail.body.id}`).set(bearer(learner));
    expect(old.body.percent).toBe(50);
    await request(app).post(`${quizUrl}/attempts`).set(bearer(learner)).send({ answers: {} });
    const over = await request(app).post(`${quizUrl}/attempts`).set(bearer(learner)).send({ answers: {} });
    expect(over.status).toBe(409);

    // a failed retake doesn't undo completion or the certificate
    const learning = await request(app).get('/api/marketplace/learning').set(bearer(learner));
    const enrolment = learning.body.find((e: { course: { id: number } }) => e.course.id === id);
    expect(enrolment).toMatchObject({ progressPercent: 100, certificateCode: code });
    expect(enrolment.completedAt).toBeTruthy();

    // unmarking and re-completing the article keeps the same certificate (one per learner and course)
    const progress = (completed: boolean) =>
      request(app)
        .put(`/api/marketplace/learning/${id}/lectures/${articleId}/progress`)
        .set(bearer(learner))
        .send({ completed });
    expect((await progress(false)).body.progressPercent).toBe(50);
    expect((await progress(true)).body.certificateCode).toBe(code);
    expect(await MktCertificate.count({ where: { courseId: id } })).toBe(1);

    const mine = await request(app).get('/api/marketplace/certificates').set(bearer(learner));
    expect(mine.body).toEqual([
      expect.objectContaining({
        code,
        learnerName: 'Asha Learner',
        sellerName: 'Cert Seller',
        verifyPath: `/market/certificates/${code}`,
      }),
    ]);

    // anyone can verify it and download the PDF
    const verify = await request(app).get(`/api/marketplace/public/certificates/${code}`);
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ valid: true, certificate: { code, learnerName: 'Asha Learner' } });
    const pdf = await request(app)
      .get(`/api/marketplace/public/certificates/${code}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('attachment');
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain('Asha Learner');
    expect(text).toContain(code);

    expect((await request(app).get('/api/marketplace/public/certificates/MKT-AAAAAAAAAA')).status).toBe(404);
    expect((await request(app).get('/api/marketplace/public/certificates/not-a-code')).status).toBe(422);
  });

  it('only enrolled learners can open a quiz', async () => {
    const seller = await newInstructor('Gate Seller');
    const { id, quizId } = await quizCourse(seller, '/api/marketplace/instructor');
    const stranger = await newAccount('Stranger');
    const url = `/api/marketplace/learning/${id}/lectures/${quizId}/quiz`;
    expect((await request(app).get(url).set(bearer(stranger))).status).toBe(404);
    expect((await request(app).get(url)).status).toBe(401);
  });
});
