import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Op } from 'sequelize';
import { DEMO_PASSWORD, USERS, bearer, getApp, lastOtpFor, login, newDevice } from './helpers';
import { User } from '../src/modules/users/user.model';
import { Branch } from '../src/modules/branches/branch.model';
import { Exam, ExamAttempt, ExamEvaluation, GradingResult } from '../src/modules/exams/models';
import { Job } from '../src/infrastructure/jobs/job.model';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { parseGradingOutput } from '../src/modules/exams/grading.service';
import { rankScores, scoreObjective } from '../src/modules/exams/scoring';

const STUDENT = { mobile: '9100000005', password: DEMO_PASSWORD };
const ZENITH_STUDENT = { mobile: '9200000005', password: DEMO_PASSWORD };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const BYPASS = { tenantBypass: true } as object;
let seq = 0;
const mobile = () => `938${String(seq++).padStart(7, '0')}`;

async function otpLogin(m: string) {
  const app = await getApp();
  const device = newDevice();
  const ch = await request(app).post('/api/auth/otp/request').send({ mobile: m, device });
  const res = await request(app)
    .post('/api/auth/otp/verify')
    .send({ challengeId: ch.body.challengeId, code: lastOtpFor(m), device });
  expect(res.body.status).toBe('authenticated');
  return res.body.accessToken as string;
}

function aiReply(content: unknown) {
  return new Response(
    JSON.stringify({
      model: 'mock-vision',
      choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
      usage: { total_tokens: 300 },
    }),
    { status: 200 },
  );
}

describe('scoring helpers', () => {
  const base = {
    text: 'q',
    options: [],
    explanation: null,
    assetFileIds: [],
    chapterId: null,
    chapterName: null,
    topicId: null,
    topicName: null,
  };
  const rule = { marks: 4, negativeMarks: 1, partialMarking: true };

  it('scores objective types with negative and partial marking', () => {
    const multi = { ...base, type: 'multiple' as const, answerKey: { options: ['A', 'B', 'C'] } };
    expect(scoreObjective(multi, rule, { options: ['A', 'B', 'C'] })).toEqual({ score: 4, isCorrect: true });
    expect(scoreObjective(multi, rule, { options: ['A'] })).toEqual({ score: 1.33, isCorrect: false });
    expect(scoreObjective(multi, { ...rule, partialMarking: false }, { options: ['A'] })!.score).toBe(0);
    expect(scoreObjective(multi, rule, { options: ['A', 'D'] })).toEqual({ score: -1, isCorrect: false });
    expect(scoreObjective(multi, rule, { options: [] })).toEqual({ score: 0, isCorrect: null });

    const num = { ...base, type: 'numerical' as const, answerKey: { value: 9.8, tolerance: 0.05 } };
    expect(scoreObjective(num, rule, { value: 9.84 })!.score).toBe(4);
    expect(scoreObjective(num, rule, { value: 9.9 })!.score).toBe(-1);
    const range = { ...base, type: 'numerical' as const, answerKey: { min: 1, max: 2 } };
    expect(scoreObjective(range, rule, { value: 2 })!.score).toBe(4);
    const tf = { ...base, type: 'true_false' as const, answerKey: { value: false } };
    expect(scoreObjective(tf, rule, { value: false })!.score).toBe(4);
    expect(scoreObjective({ ...base, type: 'descriptive', answerKey: {} }, rule, { text: 'x' })).toBeNull();
  });

  it('ranks with ties and percentiles, and clamps AI output', () => {
    const r = rankScores([
      { id: 1, score: 10 },
      { id: 2, score: 20 },
      { id: 3, score: 10 },
      { id: 4, score: 5 },
    ]);
    expect(r.get(2)).toEqual({ rank: 1, percentile: 100 });
    expect(r.get(1)).toEqual({ rank: 2, percentile: 75 });
    expect(r.get(3)!.rank).toBe(2);
    expect(r.get(4)).toEqual({ rank: 4, percentile: 25 });
    expect(parseGradingOutput('```json\n{"marks": 14, "feedback": "ok", "confidence": 2}\n```', 10)).toEqual({
      marks: 10,
      feedback: 'ok',
      confidence: 1,
    });
    expect(() => parseGradingOutput('{"feedback":"no marks"}', 10)).toThrow();
  });
});

describe('exams module', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let admin: string;
  let branchAdmin: string;
  let teacher: string;
  let s1: string;
  let s2: string;
  let parent: string;
  let zenith: string;
  let zenithStudent: string;
  let sa: string;
  let s1Id: number;
  let s2Id: number;
  let batchId: number;
  let chapterId: number;
  const q: Record<'single' | 'multiple' | 'numerical' | 'tf' | 'desc', number> = {} as never;
  let examId: number;
  let sectionA: number;
  const eq: Record<string, number> = {};
  let attempt1: number;
  let attempt2: number;

  beforeAll(async () => {
    app = await getApp();
    [admin, branchAdmin, teacher, s1, zenith, zenithStudent, sa] = await Promise.all(
      [
        USERS.apexAdmin,
        USERS.apexBranchAdmin,
        USERS.apexTeacher,
        STUDENT,
        USERS.zenithAdmin,
        ZENITH_STUDENT,
        USERS.superAdmin,
      ].map(async (u) => (await login(u)).accessToken),
    );
    s1Id = (await User.findOne({ where: { mobile: STUDENT.mobile } }))!.id;
    const branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;

    // Second student with a linked parent.
    const sm = mobile();
    const st = await request(app)
      .post('/api/students')
      .set(bearer(admin))
      .send({ name: 'Exam Kid Two', mobile: sm });
    expect(st.status).toBe(201);
    s2Id = st.body.userId;
    expect(s2Id).toBeTruthy();
    const pm = mobile();
    const link = await request(app)
      .post(`/api/students/${st.body.id}/guardians`)
      .set(bearer(admin))
      .send({ name: 'Exam Parent', mobile: pm, relation: 'mother' });
    expect(link.status).toBe(201);
    [s2, parent] = [await otpLogin(sm), await otpLogin(pm)];

    // Academics: subject → chapter/topic, course, batch with both students.
    const subj = await request(app)
      .post('/api/academics/subjects')
      .set(bearer(admin))
      .send({ name: 'Exam Physics', code: 'EXPHY' });
    chapterId = (
      await request(app)
        .post('/api/academics/chapters')
        .set(bearer(admin))
        .send({ subjectId: subj.body.id, name: 'Mechanics' })
    ).body.id;
    const topicId = (
      await request(app).post('/api/academics/topics').set(bearer(admin)).send({ chapterId, name: 'Gravity' })
    ).body.id;
    const session = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: 'EX-2045', startDate: '2045-04-01', endDate: '2046-03-31' });
    expect(session.status).toBe(201);
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: 'Exam Course', code: 'EXC-1', subjectIds: [subj.body.id], branchIds: [branchId] });
    expect(course.status).toBe(201);
    const batch = await request(app).post('/api/academics/batches').set(bearer(admin)).send({
      branchId,
      courseId: course.body.id,
      academicSessionId: session.body.id,
      name: 'Exam Batch',
      code: 'EXB-1',
      capacity: 10,
      startDate: '2045-04-01',
    });
    expect(batch.status).toBe(201);
    batchId = batch.body.id;
    const enrol = await request(app)
      .post(`/api/academics/batches/${batchId}/students`)
      .set(bearer(admin))
      .send({ studentUserIds: [s1Id, s2Id] });
    expect(enrol.status).toBe(201);

    // Question bank.
    const bank = await request(app)
      .post('/api/question-bank/banks')
      .set(bearer(teacher))
      .send({ name: 'Exam bank', visibility: 'shared' });
    const add = async (body: Record<string, unknown>) => {
      const r = await request(app)
        .post(`/api/question-bank/banks/${bank.body.id}/questions`)
        .set(bearer(teacher))
        .send({ chapterId, topicId, ...body });
      expect(r.status).toBe(201);
      return r.body.id as number;
    };
    const opts = ['A', 'B', 'C', 'D'].map((k) => ({ key: k, text: `Option ${k}` }));
    q.single = await add({
      type: 'single',
      text: 'g on Earth?',
      options: opts,
      answerKey: { options: ['A'] },
    });
    q.multiple = await add({
      type: 'multiple',
      text: 'Vectors?',
      options: opts,
      answerKey: { options: ['A', 'B'] },
    });
    q.numerical = await add({
      type: 'numerical',
      text: 'g in m/s²',
      answerKey: { value: 9.8, tolerance: 0.1 },
    });
    q.tf = await add({ type: 'true_false', text: 'Mass is a vector', answerKey: { value: false } });
    q.desc = await add({
      type: 'descriptive',
      text: 'Derive v² = u² + 2as',
      answerKey: {
        modelAnswer: 'Using v = u + at and s = ut + at²/2 …',
        rubric: '5 marks derivation, 5 marks final form',
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await request(app).delete('/api/admin/ai/settings/key').set(bearer(sa));
  });

  it('lets teachers build and schedule an exam with sections and a marking scheme', async () => {
    const now = Date.now();
    const created = await request(app)
      .post('/api/exams')
      .set(bearer(teacher))
      .send({
        title: 'Physics Unit Test 1',
        batchId,
        startAt: new Date(now - 60_000).toISOString(),
        endAt: new Date(now + 3600_000).toISOString(),
        durationMinutes: 30,
        defaultMarks: 4,
        defaultNegativeMarks: 1,
        partialMarking: true,
        shuffleQuestions: true,
        shuffleOptions: true,
        passMarks: 10,
        instituteId: 2,
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'draft',
      phase: 'draft',
      evaluationMode: 'manual',
      batchId,
    });
    examId = created.body.id;
    sectionA = created.body.sections[0].id;

    const secB = await request(app)
      .post(`/api/exams/${examId}/sections`)
      .set(bearer(teacher))
      .send({ title: 'Section B (theory)' });
    expect(secB.status).toBe(201);

    const scheduleEmpty = await request(app).post(`/api/exams/${examId}/schedule`).set(bearer(teacher));
    expect(scheduleEmpty.status).toBe(400);

    await request(app)
      .post(`/api/exams/${examId}/questions`)
      .set(bearer(teacher))
      .send({ sectionId: sectionA, questionIds: [q.single, q.multiple, q.numerical, q.tf] });
    const detail = await request(app)
      .post(`/api/exams/${examId}/questions`)
      .set(bearer(teacher))
      .send({ sectionId: secB.body.id, questionIds: [q.desc], marks: 10, negativeMarks: 0 });
    expect(detail.status).toBe(201);
    expect(detail.body.totalMarks).toBe(26);
    for (const x of detail.body.questions) eq[x.questionId] = x.id;
    expect(
      detail.body.questions.find((x: { questionId: number }) => x.questionId === q.single).question.answerKey
        .options,
    ).toEqual(['A']);

    const ai = await request(app)
      .patch(`/api/exams/${examId}`)
      .set(bearer(teacher))
      .send({ evaluationMode: 'ai_only' });
    expect(ai.status).toBe(403);

    const scheduled = await request(app).post(`/api/exams/${examId}/schedule`).set(bearer(teacher));
    expect(scheduled.status).toBe(200);
    expect(scheduled.body).toMatchObject({ status: 'scheduled', phase: 'live' });

    const inbox = await request(app).get('/api/notifications/inbox').set(bearer(s1));
    expect(JSON.stringify(inbox.body)).toContain('Physics Unit Test 1');

    const list = await request(app).get('/api/exams?phase=live').set(bearer(teacher));
    expect(list.body.items.map((e: { id: number }) => e.id)).toContain(examId);
  });

  it('keeps staff endpoints away from students/parents and isolates institutes', async () => {
    for (const tok of [s1, parent]) {
      expect((await request(app).get('/api/exams').set(bearer(tok))).status).toBe(403);
      expect((await request(app).get(`/api/exams/${examId}`).set(bearer(tok))).status).toBe(403);
    }
    expect((await request(app).post('/api/exams').set(bearer(s1)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/exams/my/${examId}/start`).set(bearer(parent))).status).toBe(403);
    expect((await request(app).post(`/api/exams/my/${examId}/start`).set(bearer(teacher))).status).toBe(403);
    expect((await request(app).get(`/api/exams/${examId}`).set(bearer(zenith))).status).toBe(404);
    expect(
      (await request(app).patch(`/api/exams/${examId}`).set(bearer(zenith)).send({ title: 'x' })).status,
    ).toBe(404);
    expect((await request(app).post(`/api/exams/my/${examId}/start`).set(bearer(zenithStudent))).status).toBe(
      404,
    );
    const zl = await request(app).get('/api/exams').set(bearer(zenith));
    expect(zl.body.items.map((e: { id: number }) => e.id)).not.toContain(examId);
  });

  it('delivers the exam without answer keys, auto-saves, resumes and scores on submit', async () => {
    const mine = await request(app).get('/api/exams/my').set(bearer(s1));
    const item = mine.body.find((i: { exam: { id: number } }) => i.exam.id === examId);
    expect(item).toMatchObject({ canStart: true, attempt: null });

    const start = await request(app).post(`/api/exams/my/${examId}/start`).set(bearer(s1));
    expect(start.status).toBe(201);
    attempt1 = start.body.attemptId;
    expect(start.body.questions).toHaveLength(5);
    expect(JSON.stringify(start.body)).not.toContain('answerKey');
    expect(JSON.stringify(start.body)).not.toContain('modelAnswer');
    const remaining = new Date(start.body.deadlineAt).getTime() - new Date(start.body.serverNow).getTime();
    expect(remaining).toBeGreaterThan(29 * 60_000);
    expect(remaining).toBeLessThanOrEqual(30 * 60_000);

    const again = await request(app).post(`/api/exams/my/${examId}/start`).set(bearer(s1));
    expect(again.body.attemptId).toBe(attempt1);

    const save = (eqId: number, body: Record<string, unknown>, tok = s1, att = attempt1) =>
      request(app).put(`/api/exams/my/attempts/${att}/answers/${eqId}`).set(bearer(tok)).send(body);
    expect((await save(eq[q.single], { response: { options: ['A'] } })).status).toBe(200);
    expect((await save(eq[q.single], { response: { options: ['Z'] } })).status).toBe(400);
    expect((await save(eq[q.multiple], { response: { options: ['A'] }, markedForReview: true })).status).toBe(
      200,
    );
    expect((await save(eq[q.numerical], { response: { value: 10.5 } })).status).toBe(200);
    expect((await save(eq[q.tf], { visited: true })).status).toBe(200);
    expect(
      (await save(eq[q.desc], { response: { text: 'v = u + at, so v² = u² + 2as.' }, timeSpentSeconds: 120 }))
        .status,
    ).toBe(200);
    // Another student cannot write to this attempt.
    expect((await save(eq[q.single], { response: { options: ['B'] } }, s2)).status).toBe(404);

    const resumed = await request(app).get(`/api/exams/my/attempts/${attempt1}`).set(bearer(s1));
    expect(resumed.status).toBe(200);
    const saved = resumed.body.answers.find(
      (a: { examQuestionId: number }) => a.examQuestionId === eq[q.multiple],
    );
    expect(saved).toMatchObject({ response: { options: ['A'] }, markedForReview: true });

    const submit = await request(app).post(`/api/exams/my/attempts/${attempt1}/submit`).set(bearer(s1));
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('submitted');
    expect((await save(eq[q.single], { response: { options: ['B'] } })).status).toBe(409);
    expect((await request(app).post(`/api/exams/my/${examId}/start`).set(bearer(s1))).status).toBe(409);

    const a = await ExamAttempt.findByPk(attempt1, BYPASS);
    // single +4, multiple partial 4×½ = 2, numerical wrong −1, true/false unanswered 0
    expect(a).toMatchObject({ objectiveScore: 5, descriptiveScore: 0, pendingEvaluations: 1, maxScore: 26 });
  });

  it('accepts multi-page handwritten answers and auto-submits at the deadline', async () => {
    const start = await request(app).post(`/api/exams/my/${examId}/start`).set(bearer(s2));
    attempt2 = start.body.attemptId;
    const base = `/api/exams/my/attempts/${attempt2}/answers/${eq[q.desc]}/pages`;
    const up = (name: string) =>
      request(app)
        .post(base)
        .set(bearer(s2))
        .attach('file', PNG, { filename: name, contentType: 'image/png' });
    expect((await up('p1.png')).status).toBe(201);
    expect((await up('p2.png')).status).toBe(201);
    const third = await up('p3.png');
    expect(third.body).toHaveLength(3);
    const [p1, p2, p3] = third.body.map((p: { id: number }) => p.id);
    expect(third.body[0].url).toBeTruthy();

    const notDesc = await request(app)
      .post(`/api/exams/my/attempts/${attempt2}/answers/${eq[q.single]}/pages`)
      .set(bearer(s2))
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(notDesc.status).toBe(400);

    const reordered = await request(app)
      .put(`${base}/order`)
      .set(bearer(s2))
      .send({ pageIds: [p3, p1, p2] });
    expect(reordered.body.map((p: { id: number }) => p.id)).toEqual([p3, p1, p2]);
    const del = await request(app).delete(`${base}/${p1}`).set(bearer(s2));
    expect(del.body.map((p: { id: number; pageNo: number }) => [p.id, p.pageNo])).toEqual([
      [p3, 1],
      [p2, 2],
    ]);

    await request(app)
      .put(`/api/exams/my/attempts/${attempt2}/answers/${eq[q.single]}`)
      .set(bearer(s2))
      .send({ response: { options: ['C'] } });

    // Time runs out: the queued auto-submit job closes the attempt.
    await ExamAttempt.update(
      { deadlineAt: new Date(Date.now() - 60_000) },
      { where: { id: attempt2 }, ...BYPASS },
    );
    await Job.update(
      { runAt: new Date(Date.now() - 1000) },
      { where: { name: 'exams.auto-submit', status: 'pending', payload: { attemptId: attempt2 } } as never },
    );
    await processDueJobs();
    const a = await ExamAttempt.findByPk(attempt2, BYPASS);
    expect(a!.status).toBe('auto_submitted');
    expect(a).toMatchObject({ objectiveScore: -1, pendingEvaluations: 1 });
    const late = await request(app)
      .put(`/api/exams/my/attempts/${attempt2}/answers/${eq[q.tf]}`)
      .set(bearer(s2))
      .send({ response: { value: false } });
    expect(late.status).toBe(409);
  });

  it('supports manual evaluation and blocks publishing until everything is evaluated', async () => {
    const evals = await request(app).get(`/api/exams/${examId}/evaluations`).set(bearer(teacher));
    expect(evals.status).toBe(200);
    expect(evals.body).toHaveLength(2);
    expect((await request(app).get(`/api/exams/${examId}/evaluations`).set(bearer(s1))).status).toBe(403);
    const typed = evals.body.find((e: { attemptId: number }) => e.attemptId === attempt1);
    expect(typed).toMatchObject({
      status: 'pending',
      maxMarks: 10,
      responseText: expect.stringContaining('v²'),
      rubric: expect.any(String),
    });
    const scanned = evals.body.find((e: { attemptId: number }) => e.attemptId === attempt2);
    expect(scanned.pages).toHaveLength(2);

    expect(
      (await request(app).post(`/api/exams/${examId}/publish`).set(bearer(branchAdmin))).body.error.code,
    ).toBe('EXAM_NOT_CLOSED');

    expect(
      (
        await request(app)
          .put(`/api/exams/${examId}/evaluations/${typed.answerId}`)
          .set(bearer(teacher))
          .send({ marks: 11 })
      ).status,
    ).toBe(400);
    const marked = await request(app)
      .put(`/api/exams/${examId}/evaluations/${typed.answerId}`)
      .set(bearer(teacher))
      .send({ marks: 8, feedback: 'Good derivation; units missing.' });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({
      status: 'finalized',
      teacherMarks: 8,
      finalMarks: 8,
      evaluatedByName: expect.any(String),
    });
    expect((await ExamAttempt.findByPk(attempt1, BYPASS))!.totalScore).toBe(13);

    await Exam.update({ endAt: new Date(Date.now() - 1000) }, { where: { id: examId }, ...BYPASS });
    const blocked = await request(app).post(`/api/exams/${examId}/publish`).set(bearer(branchAdmin));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('EVALUATION_PENDING');
  });

  it('grades handwritten answers with AI (vision) for teacher review, keeping the raw output', async () => {
    expect((await request(app).post(`/api/exams/${examId}/grading-jobs`).set(bearer(teacher))).status).toBe(
      400,
    ); // manual mode
    const mode = await request(app)
      .patch(`/api/exams/${examId}`)
      .set(bearer(teacher))
      .send({ evaluationMode: 'ai_assist' });
    expect(mode.status).toBe(200);

    await request(app).put('/api/admin/ai/settings').set(bearer(sa)).send({
      provider: 'custom',
      baseUrl: 'https://ai.example.test/v1',
      model: 'mock-vision',
      jsonMode: true,
      apiKey: 'sk-test-exams-000000000000',
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        aiReply({ marks: 12, feedback: 'Correct approach, final step unclear.', confidence: 0.82 }),
      );

    const job = await request(app).post(`/api/exams/${examId}/grading-jobs`).set(bearer(teacher));
    expect(job.status).toBe(202);
    expect(job.body).toMatchObject({ status: 'queued', total: 1, mode: 'ai_assist' });
    await processDueJobs();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    const userContent = sent.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent.filter((p: { type: string }) => p.type === 'image_url')).toHaveLength(2);
    expect(userContent[0].text).toContain('5 marks derivation');
    expect(sent.response_format).toEqual({ type: 'json_object' });

    const jobs = await request(app).get(`/api/exams/${examId}/grading-jobs`).set(bearer(teacher));
    expect(jobs.body[0]).toMatchObject({ status: 'completed', processed: 1, failed: 0 });

    const evals = await request(app)
      .get(`/api/exams/${examId}/evaluations?status=ai_suggested`)
      .set(bearer(teacher));
    expect(evals.body).toHaveLength(1);
    const ev = evals.body[0];
    expect(ev).toMatchObject({
      attemptId: attempt2,
      aiMarks: 10,
      aiConfidence: 0.82,
      teacherMarks: null,
      finalMarks: null,
    });
    // AI suggestions are not final in ai_assist mode.
    expect((await ExamAttempt.findByPk(attempt2, BYPASS))!.pendingEvaluations).toBe(1);

    const history = await request(app)
      .get(`/api/exams/${examId}/evaluations/${ev.answerId}/ai-history`)
      .set(bearer(teacher));
    expect(history.body[0]).toMatchObject({
      status: 'success',
      usedVision: true,
      marks: 10,
      model: 'mock-vision',
    });
    expect(history.body[0].rawOutput).toContain('"marks":12');

    const accepted = await request(app)
      .put(`/api/exams/${examId}/evaluations/${ev.answerId}`)
      .set(bearer(teacher))
      .send({ acceptAi: true });
    expect(accepted.body).toMatchObject({
      status: 'finalized',
      teacherMarks: 10,
      finalMarks: 10,
      aiMarks: 10,
      teacherFeedback: 'Correct approach, final step unclear.',
    });
    const stored = await ExamEvaluation.findOne({ where: { answerId: ev.answerId }, ...BYPASS });
    expect(stored!.aiResultId).toBe(history.body[0].id);
    expect(await GradingResult.count({ where: { answerId: ev.answerId }, ...BYPASS })).toBe(1);
  });

  it('publishes results with rank/percentile and notifies students and guardians', async () => {
    expect((await request(app).post(`/api/exams/${examId}/publish`).set(bearer(teacher))).status).toBe(403);
    expect(
      (await request(app).get('/api/exams/my/results').set(bearer(s1))).body.map(
        (r: { attemptId: number }) => r.attemptId,
      ),
    ).not.toContain(attempt1);

    const pub = await request(app).post(`/api/exams/${examId}/publish`).set(bearer(branchAdmin));
    expect(pub.status).toBe(200);
    expect(pub.body.phase).toBe('published');

    const attempts = await request(app).get(`/api/exams/${examId}/attempts`).set(bearer(teacher));
    const byId = new Map(attempts.body.map((a: { id: number }) => [a.id, a]));
    // s1: 4 + 2 − 1 + 8 = 13; s2: −1 + 10 = 9
    expect(byId.get(attempt1)).toMatchObject({ totalScore: 13, rank: 1, percentile: 100 });
    expect(byId.get(attempt2)).toMatchObject({
      totalScore: 9,
      rank: 2,
      percentile: 50,
      status: 'auto_submitted',
    });

    const s1Inbox = await request(app).get('/api/notifications/inbox').set(bearer(s1));
    expect(JSON.stringify(s1Inbox.body)).toContain('13/26');
    const parentInbox = await request(app).get('/api/notifications/inbox').set(bearer(parent));
    expect(JSON.stringify(parentInbox.body)).toContain('Exam Kid Two');

    expect(
      (await request(app).put(`/api/exams/${examId}/evaluations/1`).set(bearer(teacher)).send({ marks: 1 }))
        .status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('shows published results to the student and linked parents only, with PDF scorecards', async () => {
    const mine = await request(app).get('/api/exams/my/results').set(bearer(s1));
    expect(mine.body.find((r: { attemptId: number }) => r.attemptId === attempt1)).toMatchObject({
      totalScore: 13,
      rank: 1,
    });
    const detail = await request(app).get(`/api/exams/my/results/${attempt1}`).set(bearer(s1));
    expect(detail.status).toBe(200);
    expect(detail.body.passed).toBe(true);
    const single = detail.body.questions.find(
      (x: { examQuestionId: number }) => x.examQuestionId === eq[q.single],
    );
    expect(single).toMatchObject({ isCorrect: true, marks: 4, correct: { options: ['A'] } });
    const desc = detail.body.questions.find(
      (x: { examQuestionId: number }) => x.examQuestionId === eq[q.desc],
    );
    expect(desc).toMatchObject({ marks: 8, feedback: 'Good derivation; units missing.' });
    expect(detail.body.chapters[0]).toMatchObject({
      chapterName: 'Mechanics',
      topicName: 'Gravity',
      score: 13,
      maxScore: 26,
    });
    expect(detail.body.sections).toHaveLength(2);

    expect((await request(app).get(`/api/exams/my/results/${attempt2}`).set(bearer(s1))).status).toBe(404);
    const kids = await request(app).get('/api/exams/children/results').set(bearer(parent));
    expect(kids.body.map((r: { attemptId: number }) => r.attemptId)).toEqual([attempt2]);
    expect(kids.body[0].studentName).toBe('Exam Kid Two');
    expect(
      (await request(app).get(`/api/exams/children/results/${attempt2}`).set(bearer(parent))).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/api/exams/children/results/${attempt1}`).set(bearer(parent))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/exams/my/results/${attempt1}`).set(bearer(zenithStudent))).status,
    ).toBe(404);

    const pdf = await request(app)
      .get(`/api/exams/my/results/${attempt1}/scorecard.pdf`)
      .set(bearer(s1))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('Physics Unit Test 1');
    expect(text).toContain('%%EOF');
    expect(
      (await request(app).get(`/api/exams/children/results/${attempt2}/scorecard.pdf`).set(bearer(parent)))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get(`/api/exams/${examId}/attempts/${attempt2}/scorecard.pdf`).set(bearer(teacher)))
        .status,
    ).toBe(200);
  });

  it('allows authorised result corrections with audit and re-ranks', async () => {
    const staff = await request(app).get(`/api/exams/${examId}/attempts/${attempt2}`).set(bearer(teacher));
    expect(staff.status).toBe(200);
    const singleAnswer = await request(app)
      .get(`/api/exams/${examId}/evaluations?attemptId=${attempt2}`)
      .set(bearer(teacher));
    expect(singleAnswer.body).toHaveLength(1);
    const { ExamAnswer } = await import('../src/modules/exams/models');
    const wrong = await ExamAnswer.findOne({
      where: { attemptId: attempt2, examQuestionId: eq[q.single] },
      ...BYPASS,
    });

    const body = { answerId: wrong!.id, marks: 4, reason: 'Option C accepted after review (ambiguous key)' };
    expect(
      (await request(app).post(`/api/exams/${examId}/corrections`).set(bearer(teacher)).send(body)).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/exams/${examId}/corrections`)
          .set(bearer(branchAdmin))
          .send({ ...body, marks: 5 })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).post(`/api/exams/${examId}/corrections`).set(bearer(zenith)).send(body)).status,
    ).toBe(404);
    const fixed = await request(app)
      .post(`/api/exams/${examId}/corrections`)
      .set(bearer(branchAdmin))
      .send(body);
    expect(fixed.status).toBe(201);
    expect(fixed.body.attempt).toMatchObject({ totalScore: 14, rank: 1, percentile: 100 });
    expect(fixed.body.corrections[0]).toMatchObject({ beforeMarks: -1, afterMarks: 4, reason: body.reason });
    expect((await ExamAttempt.findByPk(attempt1, BYPASS))!.rank).toBe(2);

    const audit = await AuditEvent.findOne({
      where: { action: 'exam.result_corrected', entityId: String(wrong!.id) },
    });
    expect(audit!.metadata).toMatchObject({ before: -1, after: 4 });
    // The original response and auto score are preserved.
    await wrong!.reload(BYPASS);
    expect(wrong).toMatchObject({ autoScore: -1, response: { options: ['C'] } });
  });

  it('reports analytics and exports results', async () => {
    const an = await request(app).get(`/api/exams/${examId}/analytics`).set(bearer(teacher));
    expect(an.status).toBe(200);
    expect(an.body).toMatchObject({ submitted: 2, eligible: 2, highest: 14, lowest: 13, passCount: 2 });
    expect(an.body.topics[0]).toMatchObject({ chapterName: 'Mechanics', maxScore: 52 });
    const single = an.body.questions.find(
      (x: { examQuestionId: number }) => x.examQuestionId === eq[q.single],
    );
    expect(single).toMatchObject({ attempted: 2, correct: 1, averageMarks: 4 });

    const csv = await request(app).get(`/api/exams/${examId}/results.csv`).set(bearer(teacher));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Exam Kid Two');
    expect((await request(app).get(`/api/exams/${examId}/results.csv`).set(bearer(s1))).status).toBe(403);
  });

  it('auto-grades submissions in AI-only mode and leaves answers pending when AI is unavailable', async () => {
    const now = Date.now();
    const created = await request(app)
      .post('/api/exams')
      .set(bearer(admin))
      .send({
        title: 'AI-only quiz',
        batchId,
        startAt: new Date(now - 60_000).toISOString(),
        endAt: new Date(now + 3600_000).toISOString(),
        durationMinutes: 10,
        evaluationMode: 'ai_only',
      });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const d = await request(app)
      .post(`/api/exams/${id}/questions`)
      .set(bearer(admin))
      .send({ sectionId: created.body.sections[0].id, questionIds: [q.desc], marks: 5 });
    const descEq = d.body.questions[0].id;
    await request(app).post(`/api/exams/${id}/schedule`).set(bearer(admin));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      aiReply({ marks: 3.5, feedback: 'Partially correct.', confidence: 0.6 }),
    );
    const a1 = await request(app).post(`/api/exams/my/${id}/start`).set(bearer(s1));
    await request(app)
      .put(`/api/exams/my/attempts/${a1.body.attemptId}/answers/${descEq}`)
      .set(bearer(s1))
      .send({ response: { text: 'Using kinematics…' } });
    await request(app).post(`/api/exams/my/attempts/${a1.body.attemptId}/submit`).set(bearer(s1));
    await processDueJobs();
    expect(await ExamAttempt.findByPk(a1.body.attemptId, BYPASS)).toMatchObject({
      totalScore: 3.5,
      pendingEvaluations: 0,
    });

    // AI not configured: the job fails gracefully and the answer stays pending for manual marking.
    await request(app).delete('/api/admin/ai/settings/key').set(bearer(sa));
    const a2 = await request(app).post(`/api/exams/my/${id}/start`).set(bearer(s2));
    await request(app)
      .put(`/api/exams/my/attempts/${a2.body.attemptId}/answers/${descEq}`)
      .set(bearer(s2))
      .send({ response: { text: 'No idea' } });
    await request(app).post(`/api/exams/my/attempts/${a2.body.attemptId}/submit`).set(bearer(s2));
    await processDueJobs();
    expect((await ExamAttempt.findByPk(a2.body.attemptId, BYPASS))!.pendingEvaluations).toBe(1);
    const jobs = await request(app).get(`/api/exams/${id}/grading-jobs`).set(bearer(admin));
    expect(jobs.body[0]).toMatchObject({ status: 'failed' });
    expect(jobs.body[0].error).toMatch(/not configured/i);

    const others = await ExamAttempt.count({
      where: { examId: id, status: { [Op.ne]: 'in_progress' } },
      ...BYPASS,
    });
    expect(others).toBe(2);
  });
});
