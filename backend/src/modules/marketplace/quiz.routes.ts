import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  MKT_CERTIFICATE_CODE_PATTERN,
  MKT_QUIZ_MAX_OPTIONS,
  MKT_QUIZ_MAX_QUESTIONS,
  MKT_QUIZ_QUESTION_KINDS,
  type PermissionAction,
} from '@erp/shared';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { mediaRateLimit, websiteRateLimit } from '../../shared/middleware/security';
import { parse } from '../../shared/utilities/validation';
import { MODULE as QUESTION_BANK } from '../question-bank/question-bank.service';
import * as certificates from './certificates.service';
import * as quizzes from './quizzes.service';
import { ownCourse } from './courses.service';
import type * as sellers from './sellers.service';

const ids = (...names: string[]) =>
  z.object(Object.fromEntries(names.map((n) => [n, z.coerce.number().int().positive()])));
const codeParam = z.object({
  code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(MKT_CERTIFICATE_CODE_PATTERN, 'Not a certificate number')),
});

const quizInput = z.object({
  passPercent: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(100).nullable().optional(),
  shuffle: z.boolean().optional(),
  questions: z
    .array(
      z.object({
        kind: z.enum(MKT_QUIZ_QUESTION_KINDS),
        prompt: z.string().trim().min(1).max(5000),
        options: z
          .array(z.object({ key: z.string().trim().min(1).max(2), text: z.string().trim().min(1).max(1000) }))
          .min(2)
          .max(MKT_QUIZ_MAX_OPTIONS),
        correct: z.array(z.string().trim().min(1).max(2)).min(1).max(MKT_QUIZ_MAX_OPTIONS),
        explanation: z.string().trim().max(5000).nullable().optional(),
      }),
    )
    .max(MKT_QUIZ_MAX_QUESTIONS),
});

function sendPdf(res: import('express').Response, out: { name: string; data: Buffer }, download: boolean) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${out.name}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(out.data);
}

/** Public certificate verification and PDF (the certificate number is the lookup key). */
export function certificatePublicRoutes(api: Router) {
  api.get('/marketplace/public/certificates/:code', websiteRateLimit, async (req, res) => {
    res.json(await certificates.verifyCertificate(parse(codeParam, req.params).code));
  });
  api.get('/marketplace/public/certificates/:code/pdf', mediaRateLimit, async (req, res) => {
    const { download } = parse(z.object({ download: z.enum(['0', '1']).optional() }), req.query);
    sendPdf(res, await certificates.certificatePdfFile(parse(codeParam, req.params).code), download !== '0');
  });
}

/** Learner quiz taking and certificates (mounted under the authenticated `/marketplace` router). */
export function quizLearnerRoutes(r: Router) {
  r.get('/certificates', async (_req, res) => {
    res.json(await certificates.myCertificates());
  });
  r.get('/learning/:id/lectures/:lectureId/quiz', async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    res.json(await quizzes.learnerQuiz(p.id, p.lectureId));
  });
  r.post('/learning/:id/lectures/:lectureId/quiz/attempts', async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    const body = parse(
      z.object({
        answers: z.record(z.string().regex(/^\d+$/), z.array(z.string().max(2)).max(MKT_QUIZ_MAX_OPTIONS)),
      }),
      req.body ?? {},
    );
    res.status(201).json(await quizzes.submitAttempt(p.id, p.lectureId, body));
  });
  r.get('/learning/:id/lectures/:lectureId/quiz/attempts/:attemptId', async (req, res) => {
    const p = parse(ids('id', 'lectureId', 'attemptId'), req.params);
    res.json(await quizzes.attemptResult(p.id, p.lectureId, p.attemptId));
  });
}

/** Quiz builder routes inside a studio router (instructor or institute scope). */
export function quizStudioRoutes(
  r: Router,
  scope: sellers.SellerScope,
  can: (action: PermissionAction) => RequestHandler[],
  seller: () => Promise<number>,
) {
  r.get('/courses/:id/lectures/:lectureId/quiz', ...can('view'), async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    res.json(await quizzes.getOwnQuiz(await seller(), p.id, p.lectureId));
  });
  r.put('/courses/:id/lectures/:lectureId/quiz', ...can('edit'), async (req, res) => {
    const p = parse(ids('id', 'lectureId'), req.params);
    res.json(await quizzes.saveQuiz(await seller(), p.id, p.lectureId, parse(quizInput, req.body)));
  });
  if (scope === 'institute')
    r.post(
      '/courses/:id/lectures/:lectureId/quiz/import',
      ...can('edit'),
      requirePermission(QUESTION_BANK, 'view'),
      async (req, res) => {
        const p = parse(ids('id', 'lectureId'), req.params);
        const { questionIds } = parse(
          z.object({ questionIds: z.array(z.number().int().positive()).min(1).max(MKT_QUIZ_MAX_QUESTIONS) }),
          req.body,
        );
        await ownCourse(await seller(), p.id);
        res.json(await quizzes.importFromBank(await seller(), p.id, p.lectureId, questionIds));
      },
    );
}

/** Platform review of a quiz lecture (with the answer key). */
export function quizAdminRoutes(api: Router) {
  api.get(
    '/admin/marketplace/courses/:id/lectures/:lectureId/quiz',
    authenticate,
    requireSuperAdmin,
    async (req, res) => {
      const p = parse(ids('id', 'lectureId'), req.params);
      res.json(await quizzes.reviewQuiz(p.id, p.lectureId));
    },
  );
}
