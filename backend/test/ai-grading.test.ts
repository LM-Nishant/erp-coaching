import request from 'supertest';
import type { Express } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Op } from 'sequelize';
import { crc32, deflateSync } from 'node:zlib';
import {
  DEMO_PASSWORD,
  USERS,
  bearer,
  getApp,
  lastOtpFor,
  login,
  newDevice,
  purgeAcademicFixtures,
  purgeRows,
} from './helpers';
import { Branch } from '../src/modules/branches/branch.model';
import { Exam, ExamAttempt, GradingJob, GradingResult } from '../src/modules/exams/models';
import { AiSetting, AiUsage } from '../src/modules/ai/models';
import { estimateCostUsd, tokensUsedThisMonth } from '../src/modules/ai/ai.service';
import { AuditEvent } from '../src/shared/audit/audit-event.model';
import { Job } from '../src/infrastructure/jobs/job.model';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { FileObject } from '../src/modules/files/file.model';
import { getStorage } from '../src/infrastructure/storage';
import { config } from '../src/infrastructure/config';
import { getActiveSubscription } from '../src/modules/subscriptions/subscription.service';
import {
  AiProviderError,
  type ChatMessage,
  type ProviderConnection,
} from '../src/infrastructure/ai-providers/openai-compatible.client';
import {
  MOCK_FAILURE_MARKER,
  MOCK_TOKENS_PER_IMAGE,
  countImages,
  gradeAnswer,
  mockChatCompletion,
  simulatedOcr,
} from '../src/infrastructure/ai-providers/mock.client';

// ------------------------------------------------------------------------------ fixtures

const BASE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const NUL = Buffer.from([0]);
const latin = (s: string) => Buffer.from(s, 'latin1');

function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([latin(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
/** The 1×1 PNG with extra chunks inserted before IEND. */
const pngWith = (...chunks: Buffer[]) =>
  Buffer.concat([BASE_PNG.subarray(0, -12), ...chunks, BASE_PNG.subarray(-12)]);
const tEXt = (kw: string, text: string) => pngChunk('tEXt', Buffer.concat([latin(kw), NUL, latin(text)]));
const zTXt = (kw: string, text: string) =>
  pngChunk('zTXt', Buffer.concat([latin(kw), Buffer.from([0, 0]), deflateSync(latin(text))]));
function iTXt(kw: string, text: string, compressed: boolean) {
  const body = Buffer.from(text, 'utf8');
  return pngChunk(
    'iTXt',
    Buffer.concat([
      latin(kw),
      NUL,
      Buffer.from([compressed ? 1 : 0, 0]),
      latin('en'),
      NUL,
      Buffer.from('Antwort', 'utf8'),
      NUL,
      compressed ? deflateSync(body) : body,
    ]),
  );
}
function jpegWithComment(text: string) {
  const body = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe]), len, body, Buffer.from([0xff, 0xd9])]);
}
const dataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;

const QUESTION = "State Newton's second law.";
const MODEL_ANSWER = 'Force equals mass times acceleration.';
const RUBRIC = 'Formula with units';
const ANSWER_85 = 'Force equals mass times acceleration, formula F = ma.';
const ANSWER_10 = 'Force equals mass times acceleration, formula F = ma, with units of newtons.';
const HANDWRITTEN = 'Force equals mass times acceleration';
const FEEDBACK_85 =
  'Covered 6 of 7 key points (86%). Mentions: force, equals, mass, times, acceleration, formula. Missing: units.';
const UNREADABLE =
  'The handwritten pages could not be read (simulated OCR found no text). Please mark this answer manually.';

/** Mirrors the grading prompt built by the exams module. */
function gradingPrompt(o: {
  question?: string;
  max?: number;
  model?: string;
  rubric?: string;
  answer?: string;
}) {
  return [
    `Question (max ${o.max ?? 10} marks):\n${o.question ?? QUESTION}`,
    o.model === '' ? 'Model answer: (none provided)' : `Model answer:\n${o.model ?? MODEL_ANSWER}`,
    o.rubric === '' ? '' : `Rubric:\n${o.rubric ?? RUBRIC}`,
    `Student's typed answer:\n<<<\n${o.answer || '(no typed answer)'}\n>>>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const conn: ProviderConnection = {
  provider: 'mock',
  baseUrl: 'mock://local',
  model: 'mock-ai-1',
  apiKey: '',
  timeoutMs: 1000,
};
const generationPrompt = (lines: string[]): ChatMessage[] => [
  { role: 'system', content: 'Return JSON {"questions": [...]} with exactly the requested questions.' },
  { role: 'user', content: lines.join('\n') },
];

afterEach(() => vi.restoreAllMocks());

describe('mock AI provider', () => {
  it('grades typed answers by key-point coverage of the model answer and rubric', () => {
    expect(gradeAnswer(gradingPrompt({ answer: ANSWER_85 }), [])).toEqual({
      marks: 8.5,
      confidence: 0.85,
      feedback: FEEDBACK_85,
    });
    expect(gradeAnswer(gradingPrompt({ answer: ANSWER_10 }), [])).toMatchObject({ marks: 10 });
    expect(gradeAnswer(gradingPrompt({ answer: '' }), [])).toEqual({
      marks: 0,
      confidence: 0.95,
      feedback: 'No answer was provided.',
    });
    // Without a model answer or rubric the question itself is the reference, with low confidence.
    expect(
      gradeAnswer(
        gradingPrompt({
          question: 'Define inertia.',
          model: '',
          rubric: '',
          answer: 'Inertia is resistance to change',
        }),
        [],
      ),
    ).toMatchObject({ marks: 5, confidence: 0.4 });
  });

  it('reads handwritten pages with simulated OCR and flags unreadable ones', () => {
    const page = dataUrl(pngWith(tEXt('Answer', HANDWRITTEN)));
    const scanned = gradeAnswer(gradingPrompt({}), [page]);
    expect(scanned).toMatchObject({ marks: 7, confidence: 0.85 });
    expect(scanned.feedback).toMatch(/Handwritten pages were read with simulated OCR\.$/);

    expect(gradeAnswer(gradingPrompt({}), [dataUrl(BASE_PNG)])).toEqual({
      marks: 0,
      confidence: 0.2,
      feedback: UNREADABLE,
    });
    const mixed = gradeAnswer(gradingPrompt({ answer: ANSWER_85 }), [dataUrl(BASE_PNG)]);
    expect(mixed).toMatchObject({ marks: 8.5, confidence: 0.5 });
    expect(mixed.feedback).toMatch(/ 1 page\(s\) could not be read\.$/);

    expect(simulatedOcr(page)).toBe(HANDWRITTEN);
    expect(simulatedOcr(dataUrl(pngWith(zTXt('Text', 'compressed words'))))).toBe('compressed words');
    expect(simulatedOcr(dataUrl(pngWith(iTXt('Handwriting', 'F = m·a ✓', false))))).toBe('F = m·a ✓');
    expect(simulatedOcr(dataUrl(pngWith(iTXt('OCR', 'deflated ✓', true))))).toBe('deflated ✓');
    expect(simulatedOcr(dataUrl(pngWith(tEXt('Answer', 'line one'), tEXt('Comment', 'line two'))))).toBe(
      'line one\nline two',
    );
    expect(simulatedOcr(dataUrl(jpegWithComment('jpeg comment text'), 'image/jpeg'))).toBe(
      'jpeg comment text',
    );
    // Other metadata, plain images, remote URLs and non-images are unreadable.
    expect(simulatedOcr(dataUrl(pngWith(tEXt('Software', 'paint'))))).toBeNull();
    expect(simulatedOcr(dataUrl(BASE_PNG))).toBeNull();
    expect(simulatedOcr('https://files.example.test/page.png')).toBeNull();
    expect(simulatedOcr(dataUrl(latin('Answer\0not an image'), 'text/plain'))).toBeNull();
  });

  it('answers deterministically and meters ~4 characters per token plus a flat cost per image', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello there' },
          { type: 'image_url', image_url: { url: dataUrl(BASE_PNG) } },
        ],
      },
    ];
    expect(countImages(messages)).toBe(1);
    const res = mockChatCompletion(conn, { messages });
    expect(res).toMatchObject({
      content: 'Mock response to: hello there',
      model: 'mock-ai-1',
      usage: {
        promptTokens: Math.ceil(14 / 4) + MOCK_TOKENS_PER_IMAGE,
        completionTokens: 8,
        totalTokens: 777,
      },
    });
    expect(mockChatCompletion(conn, { messages, jsonMode: true }).content).toBe(
      JSON.stringify({ reply: 'Mock response to: hello there' }),
    );
    const ping = (system: string) =>
      mockChatCompletion(conn, {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: 'ping' },
        ],
      }).content;
    expect(ping('Reply with a JSON object {"ok": true}.')).toBe('{"ok":true}');
    expect(ping('Reply with the single word OK.')).toBe('OK');

    const grading: ChatMessage[] = [
      { role: 'system', content: 'You are an examiner.' },
      { role: 'user', content: gradingPrompt({ answer: ANSWER_85 }) },
    ];
    const first = mockChatCompletion(conn, { messages: grading, jsonMode: true });
    expect(JSON.parse(first.content)).toEqual({ marks: 8.5, feedback: FEEDBACK_85, confidence: 0.85 });
    expect(mockChatCompletion(conn, { messages: grading, jsonMode: true })).toMatchObject({
      content: first.content,
      usage: first.usage,
    });
  });

  it('fails like a provider error when a message carries the failure marker', () => {
    let error: unknown;
    try {
      mockChatCompletion(conn, {
        messages: [{ role: 'user', content: `Grade this ${MOCK_FAILURE_MARKER}` }],
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({
      status: 500,
      message: expect.stringContaining('simulated mock provider failure'),
    });
  });

  it('generates well-formed sample questions of the requested type, count and difficulty', () => {
    const generate = (lines: string[]) =>
      JSON.parse(mockChatCompletion(conn, { messages: generationPrompt(lines), jsonMode: true }).content)
        .questions as Array<Record<string, unknown>>;

    const many = generate(['Topic: Physics › Optics', 'Question type: multiple', 'Number of questions: 50']);
    expect(many).toHaveLength(20);
    expect(many.slice(0, 4).map((q) => q.difficulty)).toEqual(['easy', 'medium', 'hard', 'easy']);
    expect(many[0]).toMatchObject({
      type: 'multiple',
      text: '[Mock] Which statements about Physics › Optics are correct? (1)',
      answerKey: { options: ['A', 'C'] },
      tags: ['optics', 'mock'],
      explanation: 'Sample explanation 1 for Physics › Optics.',
    });
    expect(many[1].answerKey).toEqual({ options: ['B', 'D'] });

    const tf = generate([
      'Topic: Optics',
      'Question type: true_false',
      'Number of questions: 2',
      'Difficulty: hard',
    ]);
    expect(tf.map((q) => [q.difficulty, (q.answerKey as { value: boolean }).value])).toEqual([
      ['hard', true],
      ['hard', false],
    ]);
    const numerical = generate(['Topic: Optics', 'Question type: numerical', 'Number of questions: 1']);
    expect(numerical[0]).toMatchObject({
      text: '[Mock] Compute quantity 1 for Optics.',
      answerKey: { value: 10, tolerance: 0 },
    });
    const single = generate(['Topic: Optics', 'Question type: single', 'Number of questions: 0']);
    expect(single).toHaveLength(1);
    expect(single[0].answerKey).toEqual({ options: ['A'] });
  });
});

// ------------------------------------------------------------------------------ end to end

const BYPASS = { tenantBypass: true } as object;
const TEACHER = { mobile: '9440100001', password: DEMO_PASSWORD };
const STUDENT_MOBILES = ['9440100011', '9440100012', '9440100013'];

interface EvalDto {
  answerId: number;
  attemptId: number;
  studentUserId: number;
  status: string;
  aiMarks: number | null;
  aiFeedback: string | null;
  aiConfidence: number | null;
  aiProvider: string | null;
  aiModel: string | null;
  teacherMarks: number | null;
  teacherFeedback: string | null;
  finalMarks: number | null;
  responseText: string | null;
  pages: { fileId: number; url: string }[];
}

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

/** Runs `fn` as if in production (no logins inside: the dev OTP log is disabled there). */
async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
  const previous = config.isProd;
  config.isProd = true;
  try {
    return await fn();
  } finally {
    config.isProd = previous;
  }
}

describe('AI grading end to end with the mock provider', () => {
  let app: Express;
  let sa: string;
  let admin: string;
  let zenith: string;
  let teacher: string;
  let teacherId: number;
  const students: { token: string; userId: number }[] = [];
  let batchId: number;
  let subjectId: number;
  let topicId: number;
  let bankId: number;
  let questionId: number;
  const fixture: { sessionIds?: number[]; courseIds?: number[] } = {};
  const pageFileIds: number[] = [];
  const exams: { assist?: number; auto?: number; quota?: number } = {};

  let examWatermark = 0;
  let usageWatermark = 0;
  let jobWatermark = 0;
  let savedSetting: Record<string, unknown> | null = null;
  let savedOverrides: unknown = null;
  const savedConfig = { isProd: config.isProd, AI_MOCK_FALLBACK: config.AI_MOCK_FALLBACK };

  const settings = (body: Record<string, unknown>) =>
    request(app).put('/api/admin/ai/settings').set(bearer(sa)).send(body);
  const testConnection = (body: Record<string, unknown>) =>
    request(app).post('/api/admin/ai/settings/test').set(bearer(sa)).send(body);
  const aiStatus = async () => (await request(app).get('/api/exams/ai-status').set(bearer(teacher))).body;
  const generate = (body: Record<string, unknown>) =>
    request(app)
      .post('/api/question-bank/generate')
      .set(bearer(teacher))
      .send({ topicId, ...body });
  const OPENAI = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    jsonMode: true,
  };
  const MOCK = { provider: 'mock', baseUrl: 'mock://local', model: 'mock-ai-1', jsonMode: true };

  async function setLimits(overrides: Record<string, unknown> | null) {
    const sub = (await getActiveSubscription(1))!;
    await sub.update({
      limitOverrides: overrides
        ? { ...((savedOverrides as Record<string, unknown> | null) ?? {}), ...overrides }
        : (savedOverrides as never),
    });
  }

  async function createExam(token: string, title: string, evaluationMode: string) {
    const now = Date.now();
    const created = await request(app)
      .post('/api/exams')
      .set(bearer(token))
      .send({
        title,
        batchId,
        startAt: new Date(now - 60_000).toISOString(),
        endAt: new Date(now + 3600_000).toISOString(),
        durationMinutes: 30,
        evaluationMode,
      });
    expect(created.status).toBe(201);
    expect(created.body.evaluationMode).toBe(evaluationMode);
    const examId = created.body.id as number;
    const added = await request(app)
      .post(`/api/exams/${examId}/questions`)
      .set(bearer(token))
      .send({ sectionId: created.body.sections[0].id, questionIds: [questionId], marks: 10 });
    expect(added.status).toBe(201);
    expect((await request(app).post(`/api/exams/${examId}/schedule`).set(bearer(token))).status).toBe(200);
    return { examId, eqId: added.body.questions[0].id as number };
  }

  /** A student starts, answers (typed text and/or one scanned page) and submits. */
  async function sit(token: string, examId: number, eqId: number, answer: { text?: string; page?: Buffer }) {
    const start = await request(app).post(`/api/exams/my/${examId}/start`).set(bearer(token));
    expect(start.status).toBe(201);
    const attemptId = start.body.attemptId as number;
    const base = `/api/exams/my/attempts/${attemptId}/answers/${eqId}`;
    if (answer.text !== undefined) {
      const saved = await request(app)
        .put(base)
        .set(bearer(token))
        .send({ response: { text: answer.text } });
      expect(saved.status).toBe(200);
    }
    if (answer.page) {
      const up = await request(app)
        .post(`${base}/pages`)
        .set(bearer(token))
        .attach('file', answer.page, { filename: 'page-1.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      pageFileIds.push(...up.body.map((p: { fileId: number }) => p.fileId));
    }
    const submit = await request(app).post(`/api/exams/my/attempts/${attemptId}/submit`).set(bearer(token));
    expect(submit.status).toBe(200);
    return attemptId;
  }

  async function evaluations(examId: number, query = '', token = teacher) {
    const res = await request(app).get(`/api/exams/${examId}/evaluations${query}`).set(bearer(token));
    expect(res.status).toBe(200);
    return res.body as EvalDto[];
  }
  const evalOf = (rows: EvalDto[], student: number) =>
    rows.find((r) => r.studentUserId === students[student].userId)!;
  async function history(examId: number, answerId: number, token = teacher) {
    const res = await request(app)
      .get(`/api/exams/${examId}/evaluations/${answerId}/history`)
      .set(bearer(token));
    expect(res.status).toBe(200);
    return res.body;
  }
  async function jobs(examId: number) {
    const res = await request(app).get(`/api/exams/${examId}/grading-jobs`).set(bearer(teacher));
    expect(res.status).toBe(200);
    return res.body as Array<Record<string, unknown> & { id: number }>;
  }

  beforeAll(async () => {
    app = await getApp();
    // Flush anything due from earlier suites so the jobs processed below are ours.
    await processDueJobs();
    examWatermark = (await Exam.max<number, Exam>('id', BYPASS)) ?? 0;
    usageWatermark = (await AiUsage.max<number, AiUsage>('id')) ?? 0;
    jobWatermark = (await Job.max<number, Job>('id')) ?? 0;
    const setting = await AiSetting.findOne({ where: { scope: 'global' } });
    savedSetting = setting ? (setting.get({ plain: true }) as Record<string, unknown>) : null;
    savedOverrides = (await getActiveSubscription(1))!.limitOverrides ?? null;

    [sa, admin, zenith] = await Promise.all(
      [USERS.superAdmin, USERS.apexAdmin, USERS.zenithAdmin].map(async (u) => (await login(u)).accessToken),
    );
    expect((await request(app).delete('/api/admin/ai/settings/key').set(bearer(sa))).status).toBe(200);
    const branchId = (await Branch.findOne({ where: { instituteId: 1 }, order: [['id', 'ASC']] }))!.id;

    const roles = await request(app).get('/api/roles').set(bearer(admin));
    const teacherRole = roles.body.find((r: { slug: string }) => r.slug === 'teacher');
    const createdTeacher = await request(app)
      .post('/api/users')
      .set(bearer(admin))
      .send({
        name: 'AIG Teacher',
        mobile: TEACHER.mobile,
        password: TEACHER.password,
        roles: [{ roleId: teacherRole.id, branchId: null }],
        branchIds: [branchId],
      });
    expect(createdTeacher.status).toBe(201);
    teacherId = createdTeacher.body.id;
    teacher = (await login(TEACHER)).accessToken;

    for (const [i, m] of STUDENT_MOBILES.entries()) {
      const st = await request(app)
        .post('/api/students')
        .set(bearer(admin))
        .send({ name: `AIG Student ${i + 1}`, mobile: m });
      expect(st.status).toBe(201);
      students.push({ token: await otpLogin(m), userId: st.body.userId });
    }

    const subject = await request(app)
      .post('/api/academics/subjects')
      .set(bearer(admin))
      .send({ name: 'AIG Physics', code: 'AIGPHY' });
    expect(subject.status).toBe(201);
    subjectId = subject.body.id;
    const chapterId = (
      await request(app)
        .post('/api/academics/chapters')
        .set(bearer(admin))
        .send({ subjectId, name: 'Mechanics' })
    ).body.id;
    topicId = (
      await request(app)
        .post('/api/academics/topics')
        .set(bearer(admin))
        .send({ chapterId, name: 'Newton laws' })
    ).body.id;
    const session = await request(app)
      .post('/api/academics/sessions')
      .set(bearer(admin))
      .send({ name: 'AIG-2047', startDate: '2047-04-01', endDate: '2048-03-31' });
    expect(session.status).toBe(201);
    fixture.sessionIds = [session.body.id];
    const course = await request(app)
      .post('/api/academics/courses')
      .set(bearer(admin))
      .send({ name: 'AIG Course', code: 'AIG-C1', subjectIds: [subjectId], branchIds: [branchId] });
    expect(course.status).toBe(201);
    fixture.courseIds = [course.body.id];
    const batch = await request(app).post('/api/academics/batches').set(bearer(admin)).send({
      branchId,
      courseId: course.body.id,
      academicSessionId: session.body.id,
      name: 'AIG Batch',
      code: 'AIG-B1',
      capacity: 10,
      startDate: '2047-04-01',
    });
    expect(batch.status).toBe(201);
    batchId = batch.body.id;
    const enrol = await request(app)
      .post(`/api/academics/batches/${batchId}/students`)
      .set(bearer(admin))
      .send({ studentUserIds: students.map((s) => s.userId) });
    expect(enrol.status).toBe(201);

    const bank = await request(app)
      .post('/api/question-bank/banks')
      .set(bearer(teacher))
      .send({ name: 'AIG bank', visibility: 'shared' });
    expect(bank.status).toBe(201);
    bankId = bank.body.id;
    const question = await request(app)
      .post(`/api/question-bank/banks/${bankId}/questions`)
      .set(bearer(teacher))
      .send({
        chapterId,
        topicId,
        type: 'descriptive',
        text: QUESTION,
        answerKey: { modelAnswer: MODEL_ANSWER, rubric: RUBRIC },
      });
    expect(question.status).toBe(201);
    questionId = question.body.id;
  });

  afterAll(async () => {
    config.isProd = savedConfig.isProd;
    config.AI_MOCK_FALLBACK = savedConfig.AI_MOCK_FALLBACK;
    const current = await AiSetting.findOne({ where: { scope: 'global' } });
    if (savedSetting) {
      if (current) await current.update(savedSetting as never);
      else await AiSetting.create(savedSetting as never);
    } else if (current) await current.destroy();
    const sub = await getActiveSubscription(1);
    await sub?.update({ limitOverrides: savedOverrides as never });

    const examRows = await Exam.findAll({
      where: { id: { [Op.gt]: examWatermark } },
      attributes: ['id'],
      ...BYPASS,
    });
    await purgeRows(
      'exams',
      examRows.map((e) => e.id),
    );
    if (pageFileIds.length) {
      const files = await FileObject.findAll({ where: { id: pageFileIds }, ...BYPASS });
      for (const f of files) await getStorage().delete(f.storageKey);
      await purgeRows('files', pageFileIds);
    }
    if (bankId) await purgeRows('question_banks', [bankId]);
    await purgeAcademicFixtures({ batchIds: batchId ? [batchId] : [], ...fixture });
    if (subjectId) await purgeRows('subjects', [subjectId]);
    const usage = await AiUsage.findAll({ where: { id: { [Op.gt]: usageWatermark } }, attributes: ['id'] });
    await purgeRows(
      'ai_usage',
      usage.map((u) => u.id),
    );
    await Job.destroy({ where: { id: { [Op.gt]: jobWatermark } } });
  });

  it('falls back to the mock provider when no key is configured, except in production', async () => {
    const saved = await settings({ ...OPENAI, inputUsdPer1M: null, outputUsdPer1M: null });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      provider: 'openai',
      hasKey: false,
      keySource: 'none',
      effectiveProvider: 'mock',
      effectiveModel: 'mock-ai-1',
      mockReason: 'fallback',
      mockAllowed: true,
      pricingSource: 'preset',
      inputUsdPer1M: 0.15,
      outputUsdPer1M: 0.6,
    });
    expect(await aiStatus()).toMatchObject({
      available: true,
      provider: 'mock',
      model: 'mock-ai-1',
      mock: true,
    });

    const drafts = await generate({ type: 'numerical', count: 2 });
    expect(drafts.status).toBe(200);
    expect(drafts.body.model).toBe('mock-ai-1');
    expect(drafts.body.drafts).toHaveLength(2);
    expect(drafts.body.drafts[0]).toMatchObject({
      type: 'numerical',
      text: '[Mock] Compute quantity 1 for AIG Physics › Mechanics › Newton laws.',
      answerKey: { value: 10, tolerance: 0 },
      source: 'ai',
      topicId,
    });
    expect(drafts.body.drafts.map((d: { difficulty: string }) => d.difficulty)).toEqual(['easy', 'medium']);
    const row = await AiUsage.findOne({
      where: { id: { [Op.gt]: usageWatermark }, feature: 'question-bank.generate' },
      order: [['id', 'DESC']],
    });
    expect(row).toMatchObject({ instituteId: 1, provider: 'mock', model: 'mock-ai-1', status: 'success' });
    expect(row!.totalTokens).toBeGreaterThan(0);

    await asProduction(async () => {
      const dto = (await request(app).get('/api/admin/ai/settings').set(bearer(sa))).body;
      expect(dto).toMatchObject({ mockAllowed: false, mockReason: null });
      expect(await aiStatus()).toMatchObject({ available: false, reason: 'AI_NOT_CONFIGURED', mock: false });
      const blocked = await generate({ type: 'numerical', count: 1 });
      expect(blocked.status).toBe(503);
      expect(blocked.body.error.code).toBe('AI_NOT_CONFIGURED');
      expect((await testConnection(OPENAI)).body).toMatchObject({
        ok: false,
        message: 'Enter an API key for this provider',
      });
    });
  });

  it('uses a configured real provider (never the mock) and records which provider failed', async () => {
    const key = 'sk-aigaps-test-key-0000000000';
    const saved = await settings({ ...OPENAI, apiKey: key });
    expect(saved.body).toMatchObject({
      hasKey: true,
      keySource: 'database',
      effectiveProvider: 'openai',
      effectiveModel: 'gpt-4o-mini',
      mockReason: null,
    });
    expect(JSON.stringify(saved.body)).not.toContain(key);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const failed = await generate({ type: 'numerical', count: 1 });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({
      code: 'AI_PROVIDER_ERROR',
      details: { provider: 'openai', model: 'gpt-4o-mini' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.openai.com/v1/chat/completions');
    const usage = await AiUsage.findByPk(failed.body.error.details.usageId);
    expect(usage).toMatchObject({
      instituteId: 1,
      feature: 'question-bank.generate',
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'error',
      totalTokens: 0,
    });

    await asProduction(async () => {
      expect(await aiStatus()).toMatchObject({
        available: true,
        provider: 'openai',
        model: 'gpt-4o-mini',
        mock: false,
      });
    });
    const removed = await request(app).delete('/api/admin/ai/settings/key').set(bearer(sa));
    expect(removed.body).toMatchObject({ hasKey: false, mockReason: 'fallback' });
  });

  it('can select the mock explicitly with preset or custom prices, but not in production', async () => {
    const saved = await settings({ ...MOCK, inputUsdPer1M: null, outputUsdPer1M: null });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      provider: 'mock',
      effectiveProvider: 'mock',
      effectiveModel: 'mock-ai-1',
      mockReason: 'selected',
      pricingSource: 'preset',
      inputUsdPer1M: 0.15,
      outputUsdPer1M: 0.6,
    });
    expect((await testConnection(MOCK)).body).toMatchObject({
      ok: true,
      model: 'mock-ai-1',
      message: 'Connected. Model replied: {"ok":true}',
    });
    expect((await testConnection({ ...MOCK, jsonMode: false })).body).toMatchObject({
      ok: true,
      message: 'Connected. Model replied: OK',
    });
    const ping = await AiUsage.findOne({
      where: { id: { [Op.gt]: usageWatermark }, feature: 'ai.test-connection' },
      order: [['id', 'DESC']],
    });
    expect(ping).toMatchObject({ instituteId: null, provider: 'mock', status: 'success' });

    // Stored prices override the preset for cost estimates.
    const priced = await settings({ ...MOCK, inputUsdPer1M: 1, outputUsdPer1M: 2 });
    expect(priced.body).toMatchObject({ pricingSource: 'settings', inputUsdPer1M: 1, outputUsdPer1M: 2 });
    expect((await generate({ type: 'single', count: 1 })).status).toBe(200);
    const row = (await AiUsage.findOne({
      where: { id: { [Op.gt]: usageWatermark }, feature: 'question-bank.generate' },
      order: [['id', 'DESC']],
    }))!;
    expect(Number(row.estimatedCostUsd)).toBeGreaterThan(0);
    expect(Number(row.estimatedCostUsd)).toBe(estimateCostUsd({ inputUsdPer1M: 1, outputUsdPer1M: 2 }, row));
    expect((await settings({ ...MOCK, inputUsdPer1M: null, outputUsdPer1M: null })).body.pricingSource).toBe(
      'preset',
    );

    const first = await generate({ type: 'descriptive', count: 3, difficulty: 'hard' });
    const second = await generate({ type: 'descriptive', count: 3, difficulty: 'hard' });
    expect(first.status).toBe(200);
    expect(second.body.drafts).toEqual(first.body.drafts);
    expect(first.body.drafts.map((d: { difficulty: string }) => d.difficulty)).toEqual([
      'hard',
      'hard',
      'hard',
    ]);
    expect(first.body.drafts[2]).toMatchObject({
      text: '[Mock] Explain concept 3 of AIG Physics › Mechanics › Newton laws.',
      answerKey: { rubric: 'Definition 40%, principle 40%, example 20%.' },
      tags: ['newton laws', 'mock'],
    });

    await asProduction(async () => {
      const refused = await settings(MOCK);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('MOCK_AI_NOT_ALLOWED');
      expect((await testConnection(MOCK)).body).toMatchObject({
        ok: false,
        message: 'The mock AI provider is not available in production',
      });
      expect(await aiStatus()).toMatchObject({ available: false, reason: 'AI_NOT_CONFIGURED' });
      const blocked = await generate({ type: 'single', count: 1 });
      expect(blocked.status).toBe(503);
      expect(blocked.body.error.code).toBe('AI_NOT_CONFIGURED');
    });
    // The mock stays selected for the grading tests below.
    expect((await request(app).get('/api/admin/ai/settings').set(bearer(sa))).body.mockReason).toBe(
      'selected',
    );
  });

  describe('AI-assisted grading with teacher review', () => {
    let eqId: number;
    const answerIds: number[] = [];
    let jobRows: Array<Record<string, unknown> & { id: number }> = [];
    const page = pngWith(tEXt('Answer', HANDWRITTEN));

    it('grades each submission through the mock provider and keeps the AI output separate', async () => {
      const exam = await createExam(teacher, 'AIG Assisted', 'ai_assist');
      exams.assist = exam.examId;
      eqId = exam.eqId;
      await sit(students[0].token, exam.examId, eqId, { text: ANSWER_85 });
      await sit(students[1].token, exam.examId, eqId, { page });
      await sit(students[2].token, exam.examId, eqId, { text: `I am not sure. ${MOCK_FAILURE_MARKER}` });
      // One grading job per submission, run by the background worker.
      expect(await GradingJob.count({ where: { examId: exam.examId }, ...BYPASS })).toBe(3);
      await processDueJobs();

      jobRows = (await jobs(exam.examId)).reverse();
      const common = { mode: 'ai_assist', total: 1, processed: 1, provider: 'mock', model: 'mock-ai-1' };
      expect(jobRows[0]).toMatchObject({
        ...common,
        status: 'completed',
        failed: 0,
        imageCount: 0,
        error: null,
      });
      expect(jobRows[1]).toMatchObject({ ...common, status: 'completed', failed: 0, imageCount: 1 });
      expect(jobRows[2]).toMatchObject({
        ...common,
        status: 'failed',
        failed: 1,
        totalTokens: 0,
        error: '1 answer(s) could not be graded; they remain pending',
      });
      expect(jobRows[0].totalTokens).toBeGreaterThan(0);
      expect(jobRows[1].totalTokens).toBeGreaterThan(MOCK_TOKENS_PER_IMAGE);
      expect(jobRows[0].estimatedCostUsd).toBeGreaterThan(0);

      const suggested = await evaluations(exam.examId, '?status=ai_suggested');
      expect(suggested).toHaveLength(2);
      const typed = evalOf(suggested, 0);
      expect(typed).toMatchObject({
        aiMarks: 8.5,
        aiConfidence: 0.85,
        aiFeedback: FEEDBACK_85,
        aiProvider: 'mock',
        aiModel: 'mock-ai-1',
        teacherMarks: null,
        finalMarks: null,
        responseText: ANSWER_85,
      });
      const scanned = evalOf(suggested, 1);
      expect(scanned).toMatchObject({ aiMarks: 7, aiConfidence: 0.85, teacherMarks: null, finalMarks: null });
      expect(scanned.pages).toHaveLength(1);
      expect(scanned.aiFeedback).toMatch(/Handwritten pages were read with simulated OCR\.$/);
      const pending = await evaluations(exam.examId, '?status=pending');
      expect(pending).toHaveLength(1);
      expect(evalOf(pending, 2)).toMatchObject({ aiMarks: null, aiProvider: null });
      answerIds.push(typed.answerId, scanned.answerId, evalOf(pending, 2).answerId);
      // AI suggestions are not final: every attempt still waits for a teacher.
      const attempts = await ExamAttempt.findAll({ where: { examId: exam.examId }, ...BYPASS });
      expect(attempts.map((a) => a.pendingEvaluations)).toEqual([1, 1, 1]);

      const vision = await request(app)
        .get(`/api/exams/${exam.examId}/evaluations/${scanned.answerId}/ai-history`)
        .set(bearer(teacher));
      expect(vision.body).toHaveLength(1);
      expect(vision.body[0]).toMatchObject({
        status: 'success',
        provider: 'mock',
        model: 'mock-ai-1',
        usedVision: true,
        imageCount: 1,
        marks: 7,
        gradingJobId: jobRows[1].id,
      });
      expect(vision.body[0].promptTokens).toBeGreaterThan(MOCK_TOKENS_PER_IMAGE);

      const failedCall = await request(app)
        .get(`/api/exams/${exam.examId}/evaluations/${answerIds[2]}/ai-history`)
        .set(bearer(teacher));
      expect(failedCall.body[0]).toMatchObject({
        status: 'error',
        provider: 'mock',
        model: 'mock-ai-1',
        marks: null,
      });
      expect(failedCall.body[0].error).toContain('simulated mock provider failure');
      const result = (await GradingResult.findOne({ where: { answerId: answerIds[2] }, ...BYPASS }))!;
      expect(await AiUsage.findByPk(result.aiUsageId!)).toMatchObject({
        feature: 'exams.grading',
        provider: 'mock',
        status: 'error',
        totalTokens: 0,
      });
    });

    it('lets the teacher accept, override or mark by hand with a full revision history', async () => {
      const examId = exams.assist!;
      const [typed, scanned, failed] = answerIds;
      const put = (answerId: number, body: Record<string, unknown>) =>
        request(app).put(`/api/exams/${examId}/evaluations/${answerId}`).set(bearer(teacher)).send(body);

      const first = await put(typed, { marks: 9, feedback: 'Good, but give the units.' });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: 'finalized', aiMarks: 8.5, teacherMarks: 9, finalMarks: 9 });
      expect((await put(typed, { marks: 8 })).body).toMatchObject({
        teacherMarks: 8,
        finalMarks: 8,
        aiMarks: 8.5,
      });
      const accepted = await put(scanned, { acceptAi: true });
      expect(accepted.body).toMatchObject({ status: 'finalized', teacherMarks: 7, finalMarks: 7 });
      expect(accepted.body.teacherFeedback).toBe(accepted.body.aiFeedback);
      expect((await put(failed, { acceptAi: true })).status).toBe(400); // nothing to accept
      expect((await put(failed, { marks: 11 })).status).toBe(400);
      expect((await put(failed, { marks: 2, feedback: 'Marked by hand.' })).body).toMatchObject({
        status: 'finalized',
        aiMarks: null,
        teacherMarks: 2,
      });

      const h = await history(examId, typed);
      expect(h.submission).toMatchObject({ responseText: ANSWER_85, pages: [] });
      expect(h.current).toMatchObject({
        status: 'finalized',
        aiMarks: 8.5,
        teacherMarks: 8,
        finalMarks: 8,
        effectiveMarks: 8,
      });
      expect(h.aiResults).toHaveLength(1);
      expect(h.aiResults[0]).toMatchObject({
        status: 'success',
        provider: 'mock',
        model: 'mock-ai-1',
        marks: 8.5,
      });
      expect(JSON.parse(h.aiResults[0].rawOutput)).toMatchObject({ marks: 8.5, confidence: 0.85 });
      expect(
        h.revisions.map((r: Record<string, unknown>) => [
          r.kind,
          r.source,
          r.marks,
          r.previousMarks,
          r.actorName,
        ]),
      ).toEqual([
        ['ai_suggestion', 'ai', 8.5, null, null],
        ['teacher_override', 'teacher', 9, 8.5, 'AIG Teacher'],
        ['teacher_override', 'teacher', 8, 9, 'AIG Teacher'],
      ]);
      expect(h.revisions[0]).toMatchObject({
        gradingResultId: h.aiResults[0].id,
        metadata: {
          provider: 'mock',
          model: 'mock-ai-1',
          mock: true,
          confidence: 0.85,
          gradingJobId: jobRows[0].id,
        },
      });
      expect(h.published).toBeNull();

      // The original scanned page is preserved byte for byte next to the AI output and teacher marks.
      const hs = await history(examId, scanned);
      expect(hs.revisions.map((r: { kind: string }) => r.kind)).toEqual(['ai_suggestion', 'teacher_accept']);
      expect(hs.submission.pages).toHaveLength(1);
      const signed = new URL(hs.submission.pages[0].url);
      const download = await request(app)
        .get(signed.pathname + signed.search)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(download.status).toBe(200);
      expect(Buffer.compare(download.body as Buffer, page)).toBe(0);
      const hf = await history(examId, failed);
      expect(hf.aiResults.map((r: { status: string }) => r.status)).toEqual(['error']);
      expect(hf.revisions.map((r: { kind: string }) => r.kind)).toEqual(['teacher_mark']);

      expect(
        await AuditEvent.count({ where: { action: 'exam.ai_mark_reviewed', entityId: String(typed) } }),
      ).toBe(2);
      const manual = await AuditEvent.findOne({
        where: { action: 'exam.answer_evaluated', entityId: String(failed) },
      });
      expect(manual).toMatchObject({
        actorUserId: teacherId,
        metadata: { aiMarks: null, acceptedAi: false },
      });
      const completed = await AuditEvent.findAll({
        where: {
          action: 'exam.ai_grading_completed',
          entityType: 'grading_job',
          entityId: jobRows.map((j) => String(j.id)),
        },
      });
      expect(completed).toHaveLength(3);
      expect(await ExamAttempt.sum('pendingEvaluations', { where: { examId }, ...BYPASS })).toBe(0);
    });

    it('keeps grading data away from students, other institutes and the files module', async () => {
      const examId = exams.assist!;
      expect(
        (await request(app).get(`/api/exams/${examId}/evaluations`).set(bearer(students[0].token))).status,
      ).toBe(403);
      expect((await request(app).get(`/api/exams/${examId}/evaluations`).set(bearer(zenith))).status).toBe(
        404,
      );
      expect(
        (
          await request(app)
            .get(`/api/exams/${examId}/evaluations/${answerIds[0]}/history`)
            .set(bearer(zenith))
        ).status,
      ).toBe(404);
      const del = await request(app).delete(`/api/files/${pageFileIds[0]}`).set(bearer(admin));
      expect(del.status).toBe(409);
      expect(del.body.error.code).toBe('MODULE_OWNED_FILE');
      const nothing = await request(app).post(`/api/exams/${examId}/grading-jobs`).set(bearer(teacher));
      expect(nothing.status).toBe(409);
      expect(nothing.body.error.code).toBe('NOTHING_TO_GRADE');
    });
  });

  it('finalizes marks in AI-only mode and keeps them through publish, correction and unpublish', async () => {
    const forbidden = await request(app)
      .patch(`/api/exams/${exams.assist}`)
      .set(bearer(teacher))
      .send({ evaluationMode: 'ai_only' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('AI_ONLY_FORBIDDEN');

    const { examId, eqId } = await createExam(admin, 'AIG Auto', 'ai_only');
    exams.auto = examId;
    const attemptId = await sit(students[0].token, examId, eqId, { text: ANSWER_85 });
    await processDueJobs();
    const [ev] = await evaluations(examId, '', admin);
    expect(ev).toMatchObject({ status: 'finalized', aiMarks: 8.5, finalMarks: 8.5, teacherMarks: null });
    expect(await ExamAttempt.findByPk(attemptId, BYPASS)).toMatchObject({
      descriptiveScore: 8.5,
      totalScore: 8.5,
      pendingEvaluations: 0,
    });
    expect(
      (await history(examId, ev.answerId, admin)).revisions.map((r: { kind: string }) => r.kind),
    ).toEqual(['ai_final']);

    expect((await request(app).post(`/api/exams/${examId}/publish`).set(bearer(teacher))).status).toBe(403);
    const early = await request(app).post(`/api/exams/${examId}/publish`).set(bearer(admin));
    expect(early.body.error.code).toBe('EXAM_NOT_CLOSED');
    await Exam.update({ endAt: new Date(Date.now() - 1000) }, { where: { id: examId }, ...BYPASS });
    expect((await request(app).post(`/api/exams/${examId}/publish`).set(bearer(admin))).status).toBe(200);
    expect((await history(examId, ev.answerId, admin)).published).toMatchObject({
      marks: 8.5,
      attemptTotal: 8.5,
    });

    const edit = await request(app)
      .put(`/api/exams/${examId}/evaluations/${ev.answerId}`)
      .set(bearer(admin))
      .send({ marks: 9 });
    expect(edit.body.error.code).toBe('RESULTS_PUBLISHED');
    const regrade = await request(app)
      .post(`/api/exams/${examId}/grading-jobs`)
      .set(bearer(admin))
      .send({ regrade: true });
    expect(regrade.body.error.code).toBe('RESULTS_PUBLISHED');

    const corrected = await request(app)
      .post(`/api/exams/${examId}/corrections`)
      .set(bearer(admin))
      .send({ answerId: ev.answerId, marks: 9.5, reason: 'Units credited on re-check' });
    expect(corrected.status).toBe(201);
    const h = await history(examId, ev.answerId, admin);
    expect(h.current).toMatchObject({ aiMarks: 8.5, finalMarks: 8.5, effectiveMarks: 9.5 });
    expect(h.aiResults.map((r: { marks: number }) => r.marks)).toEqual([8.5]);
    expect(h.corrections).toEqual([
      expect.objectContaining({ beforeMarks: 8.5, afterMarks: 9.5, reason: 'Units credited on re-check' }),
    ]);
    expect(h.revisions.at(-1)).toMatchObject({
      kind: 'correction',
      source: 'teacher',
      marks: 9.5,
      previousMarks: 8.5,
      metadata: { afterPublish: true, reason: 'Units credited on re-check' },
    });
    expect((await ExamAttempt.findByPk(attemptId, BYPASS))!.totalScore).toBe(9.5);

    expect((await request(app).post(`/api/exams/${examId}/unpublish`).set(bearer(admin))).status).toBe(200);
    const after = await history(examId, ev.answerId, admin);
    expect(after.revisions.map((r: { kind: string }) => r.kind)).toEqual([
      'ai_final',
      'published',
      'correction',
      'unpublished',
    ]);
    expect(after.revisions.at(-1)).toMatchObject({ source: 'system', marks: 9.5 });
  });

  it('stops grading when the monthly AI quota runs out and resumes once it is raised', async () => {
    const { examId, eqId } = await createExam(teacher, 'AIG Quota', 'manual');
    exams.quota = examId;
    await sit(students[0].token, examId, eqId, { text: ANSWER_85 });
    expect((await request(app).post(`/api/exams/${examId}/grading-jobs`).set(bearer(teacher))).status).toBe(
      400,
    );
    const switched = await request(app)
      .patch(`/api/exams/${examId}`)
      .set(bearer(teacher))
      .send({ evaluationMode: 'ai_assist' });
    expect(switched.status).toBe(200);
    const grade = (body: Record<string, unknown> = {}) =>
      request(app).post(`/api/exams/${examId}/grading-jobs`).set(bearer(teacher)).send(body);

    try {
      const used = await tokensUsedThisMonth(1);
      await setLimits({ aiTokensMonthly: used });
      expect(await aiStatus()).toMatchObject({
        available: false,
        reason: 'AI_QUOTA_EXCEEDED',
        tokensUsed: used,
        monthlyLimit: used,
        remainingTokens: 0,
      });
      // Submitting still works; the submission simply waits for grading.
      await sit(students[1].token, examId, eqId, { text: ANSWER_10 });
      expect(await GradingJob.count({ where: { examId }, ...BYPASS })).toBe(0);
      const refused = await grade();
      expect(refused.status).toBe(429);
      expect(refused.body.error).toMatchObject({
        code: 'AI_QUOTA_EXCEEDED',
        details: { used, limit: used, remaining: 0 },
      });

      // Room for one call: the first answer is graded, then the job stops and leaves the rest pending.
      await setLimits({ aiTokensMonthly: used + 1 });
      const queued = await grade();
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ status: 'queued', total: 2 });
      await processDueJobs();
      const [stopped] = await jobs(examId);
      expect(stopped).toMatchObject({
        status: 'failed',
        processed: 2,
        failed: 1,
        error: 'Monthly AI usage limit reached for this institute',
      });
      const rows = await evaluations(examId);
      expect(evalOf(rows, 0)).toMatchObject({ status: 'ai_suggested', aiMarks: 8.5 });
      expect(evalOf(rows, 1)).toMatchObject({ status: 'pending', aiMarks: null });
      const blocked = (await GradingResult.findOne({
        where: { answerId: evalOf(rows, 1).answerId },
        ...BYPASS,
      }))!;
      expect(blocked).toMatchObject({ status: 'error', provider: null, aiUsageId: null });
      const audit = await AuditEvent.findOne({
        where: { action: 'exam.ai_grading_stopped', entityId: String(stopped.id) },
      });
      expect(audit!.metadata).toMatchObject({ examId, code: 'AI_QUOTA_EXCEEDED', processed: 2, failed: 1 });
    } finally {
      await setLimits(null);
    }

    const resumed = await grade();
    expect(resumed.body).toMatchObject({ total: 1 });
    await processDueJobs();
    expect((await jobs(examId))[0]).toMatchObject({ status: 'completed', failed: 0 });
    const rows = await evaluations(examId);
    expect(evalOf(rows, 1)).toMatchObject({ status: 'ai_suggested', aiMarks: 10 });

    const regrade = await grade({ regrade: true });
    expect(regrade.body).toMatchObject({ total: 2 });
    await processDueJobs();
    const h = await history(examId, evalOf(rows, 0).answerId);
    expect(h.revisions.map((r: Record<string, unknown>) => [r.kind, r.marks, r.previousMarks])).toEqual([
      ['ai_suggestion', 8.5, null],
      ['ai_suggestion', 8.5, 8.5],
    ]);
    expect(h.aiResults).toHaveLength(2);
  });

  it('refuses AI evaluation modes and grading when the plan has no AI', async () => {
    try {
      await setLimits({ enabledModules: ['exams', 'academics', 'question-bank', 'students', 'files'] });
      const now = Date.now();
      const exam = {
        title: 'AIG No AI',
        batchId,
        startAt: new Date(now + 3600_000).toISOString(),
        endAt: new Date(now + 7200_000).toISOString(),
        durationMinutes: 30,
      };
      const created = await request(app)
        .post('/api/exams')
        .set(bearer(teacher))
        .send({ ...exam, evaluationMode: 'ai_assist' });
      expect(created.status).toBe(403);
      expect(created.body.error.code).toBe('MODULE_DISABLED');
      expect((await request(app).post('/api/exams').set(bearer(teacher)).send(exam)).status).toBe(201);
      const patched = await request(app)
        .patch(`/api/exams/${exams.quota}`)
        .set(bearer(admin))
        .send({ evaluationMode: 'ai_only' });
      expect(patched.body.error.code).toBe('MODULE_DISABLED');
      const regrade = await request(app)
        .post(`/api/exams/${exams.quota}/grading-jobs`)
        .set(bearer(teacher))
        .send({ regrade: true });
      expect(regrade.status).toBe(403);
      expect(regrade.body.error.code).toBe('MODULE_DISABLED');
      expect(await aiStatus()).toMatchObject({ available: false, reason: 'MODULE_DISABLED' });
    } finally {
      await setLimits(null);
    }
  });

  it('meters every grading call with provider, tokens, images and cost', async () => {
    const summary = await request(app).get('/api/ai/usage').set(bearer(admin));
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ available: true, provider: 'mock', mock: true });
    const grading = summary.body.byFeature.find((f: { feature: string }) => f.feature === 'exams.grading');
    expect(grading.requests).toBeGreaterThanOrEqual(8);
    expect(grading.errors).toBeGreaterThanOrEqual(1);
    expect(grading.images).toBeGreaterThanOrEqual(1);
    expect(grading.estimatedCostUsd).toBeGreaterThan(0);

    const platform = await request(app).get('/api/admin/ai/usage?days=1').set(bearer(sa));
    expect(
      platform.body.byProvider.find(
        (p: { provider: string; model: string }) => p.provider === 'mock' && p.model === 'mock-ai-1',
      ).calls,
    ).toBeGreaterThan(0);
    expect(
      platform.body.byProvider.find(
        (p: { provider: string; model: string }) => p.provider === 'openai' && p.model === 'gpt-4o-mini',
      ).errors,
    ).toBeGreaterThan(0);
    expect(platform.body.byInstitute.find((i: { instituteId: number }) => i.instituteId === 1)).toBeTruthy();

    // Every graded answer links to the usage row that metered it, and job totals add up.
    const examIds = Object.values(exams);
    const gradingJobs = await GradingJob.findAll({ where: { examId: examIds }, ...BYPASS });
    const results = await GradingResult.findAll({
      where: { gradingJobId: gradingJobs.map((j) => j.id) },
      ...BYPASS,
    });
    expect(results.filter((r) => r.status === 'success').length).toBeGreaterThanOrEqual(7);
    for (const r of results.filter((x) => x.status === 'success')) {
      const usage = (await AiUsage.findByPk(r.aiUsageId!))!;
      expect(usage).toMatchObject({
        feature: 'exams.grading',
        instituteId: 1,
        provider: r.provider,
        model: r.model,
        totalTokens: r.totalTokens,
        imageCount: r.imageCount,
        status: 'success',
      });
      expect(Number(usage.estimatedCostUsd)).toBeCloseTo(Number(r.estimatedCostUsd), 6);
    }
    for (const job of gradingJobs) {
      const mine = results.filter((r) => r.gradingJobId === job.id);
      expect(job.totalTokens).toBe(mine.reduce((n, r) => n + r.totalTokens, 0));
      expect(job.imageCount).toBe(mine.reduce((n, r) => n + r.imageCount, 0));
      expect(Number(job.estimatedCostUsd)).toBeCloseTo(
        mine.reduce((n, r) => n + Number(r.estimatedCostUsd ?? 0), 0),
        6,
      );
    }
  });
});
