import { Router } from 'express';
import { z } from 'zod';
import { DOUBT_BOXES, DOUBT_QUESTION_MAX, DOUBT_STATUSES } from '@erp/shared';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { uploadMiddleware } from '../files/files.routes';
import {
  MODULE,
  askDoubt,
  doubtCounts,
  doubtOptions,
  getDoubt,
  listDoubts,
  replyToDoubt,
  resolveDoubt,
} from './doubts.service';

const optionalId = z.preprocess(
  (v) => (v === '' || v === 'null' ? undefined : v),
  z.coerce.number().int().positive().optional(),
);

const askSchema = z.object({
  question: z.string().trim().min(3, 'Write your doubt').max(DOUBT_QUESTION_MAX),
  batchId: optionalId,
  subjectId: optionalId,
  lectureId: optionalId,
  liveClassId: optionalId,
  positionSeconds: z.preprocess(
    (v) => (v === '' || v === 'null' ? undefined : v),
    z.coerce.number().int().min(0).max(86_400).optional(),
  ),
});

const listSchema = paginationSchema.extend({
  box: z.enum(DOUBT_BOXES).default('mine'),
  status: z.enum(DOUBT_STATUSES).optional(),
});

const replySchema = z.object({ body: z.string().trim().max(DOUBT_QUESTION_MAX).optional() });

export function doubtRoutes(api: Router) {
  const r = Router();
  // Doubts are part of the learning experience, so they follow the LMS plan module.
  r.use(authenticate, requireModule('lms'));
  const view = requirePermission(MODULE, 'view');

  r.get('/', view, async (req, res) => res.json(await listDoubts(parse(listSchema, req.query))));
  r.get('/counts', view, async (_req, res) => res.json(await doubtCounts()));
  r.get('/options', requirePermission(MODULE, 'create'), async (_req, res) => res.json(await doubtOptions()));
  r.post('/', requirePermission(MODULE, 'create'), uploadMiddleware, async (req, res) => {
    const file = req.file ?? undefined;
    let input;
    try {
      input = parse(askSchema, req.body ?? {});
    } catch (err) {
      if (file) await import('node:fs').then((fs) => fs.promises.rm(file.path, { force: true }));
      throw err;
    }
    res.status(201).json(await askDoubt(input, file));
  });
  r.get('/:id', view, async (req, res) => res.json(await getDoubt(parse(idParam, req.params).id)));
  r.post('/:id/replies', view, uploadMiddleware, async (req, res) => {
    const file = req.file ?? undefined;
    let id: number;
    let body: string | undefined;
    try {
      id = parse(idParam, req.params).id;
      body = parse(replySchema, req.body ?? {}).body;
    } catch (err) {
      if (file) await import('node:fs').then((fs) => fs.promises.rm(file.path, { force: true }));
      throw err;
    }
    res.status(201).json(await replyToDoubt(id, body, file));
  });
  r.post('/:id/resolve', view, async (req, res) =>
    res.json(await resolveDoubt(parse(idParam, req.params).id)),
  );

  api.use('/doubts', r);
}
