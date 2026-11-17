import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { QUESTION_DIFFICULTIES, QUESTION_STATUSES, QUESTION_TYPES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { BadRequest } from '../../shared/errors';
import { uploadMiddleware } from '../files/files.routes';
import { bankSchema, generateSchema, questionPatchSchema, questionSchema } from './schemas';
import * as svc from './question-bank.service';

const M = svc.MODULE;
const can = (action: Parameters<typeof requirePermission>[1]) => requirePermission(M, action);
const optId = z.coerce.number().int().positive().optional();

const questionQuery = paginationSchema.extend({
  bankId: optId,
  type: z.enum(QUESTION_TYPES).optional(),
  difficulty: z.enum(QUESTION_DIFFICULTIES).optional(),
  status: z.enum(QUESTION_STATUSES).optional(),
  subjectId: optId,
  chapterId: optId,
  topicId: optId,
  tag: z.string().trim().max(40).optional(),
  q: z.string().trim().max(100).optional(),
});

const assetParams = idParam.extend({ assetId: z.coerce.number().int().positive() });

export function questionBankRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule(M));

  // Banks
  r.get('/banks', can('view'), async (req, res) => {
    const q = parse(z.object({ subjectId: optId, q: z.string().trim().max(100).optional() }), req.query);
    res.json(await svc.listBanks(q));
  });
  r.post('/banks', can('create'), async (req, res) => {
    res.status(201).json(await svc.createBank(parse(bankSchema, req.body)));
  });
  r.get('/banks/:id', can('view'), async (req, res) => {
    res.json(await svc.getBank(parse(idParam, req.params).id));
  });
  r.patch('/banks/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.updateBank(id, parse(bankSchema.partial(), req.body)));
  });
  r.delete('/banks/:id', can('delete'), async (req, res) => {
    await svc.deleteBank(parse(idParam, req.params).id);
    res.status(204).end();
  });
  r.post('/banks/:id/questions', can('create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.status(201).json(await svc.createQuestion(id, parse(questionSchema, req.body)));
  });
  /** Saves several reviewed questions at once (e.g. accepted AI drafts). */
  r.post('/banks/:id/questions/bulk', can('create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { questions } = parse(z.object({ questions: z.array(questionSchema).min(1).max(50) }), req.body);
    res.status(201).json(await svc.createQuestions(id, questions));
  });
  r.post('/banks/:id/option-images', can('create'), uploadMiddleware, async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (!req.file) throw BadRequest('Attach an image in the `file` field');
    res.status(201).json(await svc.uploadOptionImage(id, req.file));
  });
  r.post('/banks/:id/import', can('create'), uploadMiddleware, async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (!req.file) throw BadRequest('Attach a .csv or .xlsx file in the `file` field');
    const file = req.file;
    try {
      const buffer = await fs.promises.readFile(file.path);
      res.json(
        await svc.importQuestions(id, { buffer, originalName: file.originalname, mimeType: file.mimetype }),
      );
    } finally {
      await fs.promises.rm(file.path, { force: true });
    }
  });
  r.get('/banks/:id/export.csv', can('export'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="question-bank-${id}.csv"`);
    res.send(await svc.exportQuestionsCsv(id));
  });
  r.get('/import-template.csv', can('view'), async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="question-import-template.csv"');
    res.send(svc.importTemplateCsv());
  });

  // AI drafts (not saved)
  r.post('/generate', can('create'), async (req, res) => {
    res.json(await svc.generateDrafts(parse(generateSchema, req.body)));
  });

  // Questions
  r.get('/questions', can('view'), async (req, res) => {
    res.json(await svc.listQuestions(parse(questionQuery, req.query)));
  });
  r.get('/questions/:id', can('view'), async (req, res) => {
    res.json(await svc.getQuestion(parse(idParam, req.params).id));
  });
  r.patch('/questions/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.updateQuestion(id, parse(questionPatchSchema, req.body)));
  });
  r.delete('/questions/:id', can('delete'), async (req, res) => {
    await svc.deleteQuestion(parse(idParam, req.params).id);
    res.status(204).end();
  });
  r.post('/questions/:id/assets', can('edit'), uploadMiddleware, async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (!req.file) throw BadRequest('Attach an image in the `file` field');
    const { role } = parse(
      z.object({ role: z.enum(['question', 'explanation']).default('question') }),
      req.body ?? {},
    );
    res.status(201).json(await svc.addAsset(id, req.file, role));
  });
  r.delete('/questions/:id/assets/:assetId', can('edit'), async (req, res) => {
    const { id, assetId } = parse(assetParams, req.params);
    res.json(await svc.removeAsset(id, assetId));
  });

  api.use('/question-bank', r);
}
