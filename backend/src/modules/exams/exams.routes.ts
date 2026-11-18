import { Router } from 'express';
import { z } from 'zod';
import { EVALUATION_MODES, EVALUATION_STATUSES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { BadRequest } from '../../shared/errors';
import { uploadMiddleware } from '../files/files.routes';
import * as exams from './exams.service';
import * as attempts from './attempts.service';
import * as grading from './grading.service';
import * as results from './results.service';

const M = exams.MODULE;
/** Student/parent facing permission module (taking exams, viewing own/children's results). */
export const PORTAL = 'exam-portal';
type Action = Parameters<typeof requirePermission>[1];
const can = (action: Action) => requirePermission(M, action);
const portal = (action: Action) => requirePermission(PORTAL, action);

const id = z.coerce.number().int().positive();
const optId = id.optional();
const iso = z.string().datetime({ offset: true });
const marks = z.number().min(0).max(1000);
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

const examBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: nullableText(5000),
  instructions: nullableText(10000),
  batchId: id.nullable().optional(),
  courseId: id.nullable().optional(),
  branchId: id.nullable().optional(),
  subjectId: id.nullable().optional(),
  startAt: iso,
  endAt: iso,
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  evaluationMode: z.enum(EVALUATION_MODES).optional(),
  promptVersionId: id.nullable().optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
  partialMarking: z.boolean().optional(),
  defaultMarks: marks.optional(),
  defaultNegativeMarks: marks.optional(),
  passMarks: z.number().min(0).max(100000).nullable().optional(),
});

const sectionBody = z.object({
  title: z.string().trim().min(1).max(150),
  instructions: nullableText(5000),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

const addQuestionsBody = z.object({
  sectionId: id,
  questionIds: z.array(id).min(1).max(500),
  marks: marks.optional(),
  negativeMarks: marks.optional(),
});

const examQuestionPatch = z.object({
  sectionId: id.optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  marks: marks.optional(),
  negativeMarks: marks.optional(),
  partialMarking: z.boolean().optional(),
});

const responseBody = z
  .object({
    options: z.array(z.string().trim().toUpperCase().max(5)).max(26).optional(),
    value: z.union([z.number().finite(), z.boolean()]).nullable().optional(),
    text: z.string().max(50000).nullable().optional(),
  })
  .nullable();

const saveBody = z.object({
  response: responseBody.optional(),
  markedForReview: z.boolean().optional(),
  visited: z.boolean().optional(),
  timeSpentSeconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600)
    .optional(),
});

const evaluateBody = z
  .object({
    marks: z.number().min(0).max(1000).optional(),
    feedback: nullableText(5000),
    acceptAi: z.boolean().optional(),
  })
  .refine((b) => b.acceptAi || b.marks !== undefined, { message: 'Enter marks or accept the AI suggestion' });

const correctionBody = z.object({
  answerId: id,
  marks: z.number().min(-1000).max(1000),
  reason: z.string().trim().min(3).max(1000),
});

const promptBody = z.object({
  name: z.string().trim().min(1).max(120),
  systemPrompt: z.string().trim().min(20).max(20000),
  notes: nullableText(2000),
  activate: z.boolean().optional(),
});

const examQuery = paginationSchema.extend({
  status: z.enum(['draft', 'scheduled', 'cancelled']).optional(),
  phase: z.enum(['draft', 'upcoming', 'live', 'closed', 'published', 'cancelled']).optional(),
  batchId: optId,
  courseId: optId,
  q: z.string().trim().max(100).optional(),
});

const sectionParams = idParam.extend({ sectionId: id });
const eqParams = idParam.extend({ eqId: id });
const attemptParams = idParam.extend({ attemptId: id });
const answerParams = idParam.extend({ answerId: id });
const myEqParams = idParam.extend({ eqId: id });
const pageParams = myEqParams.extend({ pageId: id });

function sendPdf(res: import('express').Response, out: { filename: string; pdf: Buffer }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.pdf);
}

export function examRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule(M));

  // ------------------------------------------------ student portal (declared before /:id routes)
  r.get('/my', portal('view'), async (_req, res) => res.json(await attempts.listMyExams()));
  r.post('/my/:id/start', portal('create'), async (req, res) => {
    res.status(201).json(await attempts.startAttempt(parse(idParam, req.params).id));
  });
  r.get('/my/attempts/:id', portal('create'), async (req, res) => {
    res.json(await attempts.resumeAttempt(parse(idParam, req.params).id));
  });
  r.put('/my/attempts/:id/answers/:eqId', portal('create'), async (req, res) => {
    const p = parse(myEqParams, req.params);
    res.json(await attempts.saveAnswer(p.id, p.eqId, parse(saveBody, req.body)));
  });
  r.post('/my/attempts/:id/answers/:eqId/pages', portal('create'), uploadMiddleware, async (req, res) => {
    const p = parse(myEqParams, req.params);
    if (!req.file) throw BadRequest('Attach a page image as "file"');
    res.status(201).json(await attempts.addPage(p.id, p.eqId, req.file));
  });
  r.put('/my/attempts/:id/answers/:eqId/pages/order', portal('create'), async (req, res) => {
    const p = parse(myEqParams, req.params);
    const { pageIds } = parse(z.object({ pageIds: z.array(id).max(50) }), req.body);
    res.json(await attempts.reorderPages(p.id, p.eqId, pageIds));
  });
  r.delete('/my/attempts/:id/answers/:eqId/pages/:pageId', portal('create'), async (req, res) => {
    const p = parse(pageParams, req.params);
    res.json(await attempts.deletePage(p.id, p.eqId, p.pageId));
  });
  r.post('/my/attempts/:id/submit', portal('create'), async (req, res) => {
    res.json(await attempts.submitAttempt(parse(idParam, req.params).id));
  });
  r.get('/my/results', portal('view'), async (_req, res) => res.json(await results.myResults()));
  r.get('/my/results/:id', portal('view'), async (req, res) => {
    res.json(await results.viewerResult(parse(idParam, req.params).id, 'student'));
  });
  r.get('/my/results/:id/scorecard.pdf', portal('view'), async (req, res) => {
    sendPdf(res, await results.viewerScorecard(parse(idParam, req.params).id, 'student'));
  });

  // ------------------------------------------------ parent portal
  r.get('/children/results', portal('view'), async (_req, res) => res.json(await results.childrenResults()));
  r.get('/children/results/:id', portal('view'), async (req, res) => {
    res.json(await results.viewerResult(parse(idParam, req.params).id, 'parent'));
  });
  r.get('/children/results/:id/scorecard.pdf', portal('view'), async (req, res) => {
    sendPdf(res, await results.viewerScorecard(parse(idParam, req.params).id, 'parent'));
  });

  // ------------------------------------------------ AI prompt versions
  r.get('/prompt-versions', can('configure'), async (_req, res) =>
    res.json(await grading.listPromptVersions()),
  );
  r.post('/prompt-versions', can('configure'), async (req, res) => {
    res.status(201).json(await grading.createPromptVersion(parse(promptBody, req.body)));
  });
  r.post('/prompt-versions/activate', can('configure'), async (req, res) => {
    const { id: pv } = parse(z.object({ id: id.nullable() }), req.body);
    res.json(await grading.activatePromptVersion(pv));
  });

  // AI grading availability (provider, plan, remaining monthly quota) for the evaluation screens.
  r.get('/ai-status', can('approve'), async (_req, res) => res.json(await grading.gradingAiStatus()));

  // ------------------------------------------------ staff: exams
  r.get('/', can('view'), async (req, res) => res.json(await exams.listExams(parse(examQuery, req.query))));
  r.post('/', can('create'), async (req, res) => {
    res.status(201).json(await exams.createExam(parse(examBody, req.body)));
  });
  r.get('/:id', can('view'), async (req, res) =>
    res.json(await exams.getExamDetail(parse(idParam, req.params).id)),
  );
  r.patch('/:id', can('edit'), async (req, res) => {
    res.json(await exams.updateExam(parse(idParam, req.params).id, parse(examBody.partial(), req.body)));
  });
  r.delete('/:id', can('delete'), async (req, res) => {
    await exams.deleteExam(parse(idParam, req.params).id);
    res.status(204).end();
  });
  r.post('/:id/schedule', can('edit'), async (req, res) =>
    res.json(await exams.scheduleExam(parse(idParam, req.params).id)),
  );
  r.post('/:id/cancel', can('edit'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    res.json(await exams.cancelExam(parse(idParam, req.params).id, reason));
  });
  r.post('/:id/duplicate', can('create'), async (req, res) => {
    res.status(201).json(await exams.duplicateExam(parse(idParam, req.params).id));
  });

  // sections & questions
  r.post('/:id/sections', can('edit'), async (req, res) => {
    res.status(201).json(await exams.addSection(parse(idParam, req.params).id, parse(sectionBody, req.body)));
  });
  r.patch('/:id/sections/:sectionId', can('edit'), async (req, res) => {
    const p = parse(sectionParams, req.params);
    res.json(await exams.updateSection(p.id, p.sectionId, parse(sectionBody.partial(), req.body)));
  });
  r.delete('/:id/sections/:sectionId', can('edit'), async (req, res) => {
    const p = parse(sectionParams, req.params);
    await exams.deleteSection(p.id, p.sectionId);
    res.status(204).end();
  });
  r.post('/:id/questions', can('edit'), async (req, res) => {
    res
      .status(201)
      .json(await exams.addQuestions(parse(idParam, req.params).id, parse(addQuestionsBody, req.body)));
  });
  r.patch('/:id/questions/:eqId', can('edit'), async (req, res) => {
    const p = parse(eqParams, req.params);
    res.json(await exams.updateExamQuestion(p.id, p.eqId, parse(examQuestionPatch, req.body)));
  });
  r.post('/:id/questions/:eqId/refresh', can('edit'), async (req, res) => {
    const p = parse(eqParams, req.params);
    res.json(await exams.refreshSnapshot(p.id, p.eqId));
  });
  r.delete('/:id/questions/:eqId', can('edit'), async (req, res) => {
    const p = parse(eqParams, req.params);
    await exams.removeExamQuestion(p.id, p.eqId);
    res.status(204).end();
  });

  // attempts, evaluation & AI grading
  r.get('/:id/attempts', can('view'), async (req, res) =>
    res.json(await results.listAttempts(parse(idParam, req.params).id)),
  );
  r.get('/:id/attempts/:attemptId', can('view'), async (req, res) => {
    const p = parse(attemptParams, req.params);
    res.json(await results.staffResult(p.id, p.attemptId));
  });
  r.get('/:id/attempts/:attemptId/scorecard.pdf', can('view'), async (req, res) => {
    const p = parse(attemptParams, req.params);
    sendPdf(res, await results.staffScorecard(p.id, p.attemptId));
  });
  r.get('/:id/evaluations', can('approve'), async (req, res) => {
    const q = parse(
      z.object({ status: z.enum(EVALUATION_STATUSES).optional(), examQuestionId: optId, attemptId: optId }),
      req.query,
    );
    res.json(await grading.listEvaluations(parse(idParam, req.params).id, q));
  });
  r.put('/:id/evaluations/:answerId', can('approve'), async (req, res) => {
    const p = parse(answerParams, req.params);
    const b = parse(evaluateBody, req.body);
    res.json(
      await grading.evaluateAnswer(p.id, p.answerId, {
        marks: b.marks,
        feedback: b.feedback,
        acceptAi: b.acceptAi,
      }),
    );
  });
  r.get('/:id/evaluations/:answerId/ai-history', can('approve'), async (req, res) => {
    const p = parse(answerParams, req.params);
    res.json(await grading.aiHistory(p.id, p.answerId));
  });
  r.get('/:id/evaluations/:answerId/history', can('approve'), async (req, res) => {
    const p = parse(answerParams, req.params);
    res.json(await grading.answerHistory(p.id, p.answerId));
  });
  r.get('/:id/grading-jobs', can('approve'), async (req, res) => {
    res.json(await grading.listGradingJobs(parse(idParam, req.params).id));
  });
  r.post('/:id/grading-jobs', can('approve'), async (req, res) => {
    const { regrade } = parse(z.object({ regrade: z.boolean().optional() }), req.body ?? {});
    res.status(202).json(await grading.startGrading(parse(idParam, req.params).id, { regrade }));
  });

  // results
  r.get('/:id/analytics', can('view'), async (req, res) =>
    res.json(await results.analytics(parse(idParam, req.params).id)),
  );
  r.get('/:id/results.csv', can('export'), async (req, res) => {
    const out = await results.resultsCsv(parse(idParam, req.params).id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.csv);
  });
  r.post('/:id/publish', can('publish'), async (req, res) =>
    res.json(await results.publishResults(parse(idParam, req.params).id)),
  );
  r.post('/:id/unpublish', can('publish'), async (req, res) => {
    res.json(await results.unpublishResults(parse(idParam, req.params).id));
  });
  r.post('/:id/corrections', can('publish'), async (req, res) => {
    res
      .status(201)
      .json(await results.correctResult(parse(idParam, req.params).id, parse(correctionBody, req.body)));
  });

  api.use('/exams', r);
}
