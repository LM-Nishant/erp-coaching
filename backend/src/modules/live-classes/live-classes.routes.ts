import express, { Router } from 'express';
import { z } from 'zod';
import { LIVE_SESSION_STATUSES } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { webhookRateLimit } from '../../shared/middleware/security';
import { BadRequest } from '../../shared/errors';
import { uploadMiddleware } from '../files/files.routes';
import * as svc from './live-classes.service';
import { handleProviderWebhook, streamingStatus, testStreamingConnection } from './provider-webhooks';

const M = svc.MODULE;
const can = (action: Parameters<typeof requirePermission>[1]) => requirePermission(M, action);

const boolFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
const posInt = z.number().int().positive();

const listQuery = paginationSchema.extend({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(LIVE_SESSION_STATUSES)).optional()),
  batchId: z.coerce.number().int().positive().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  upcoming: boolFlag,
});

const createBody = z
  .object({
    classSessionId: posInt.optional(),
    batchId: posInt.optional(),
    teacherUserId: posInt.optional(),
    subjectId: posInt.nullable().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    scheduledStartAt: z.string().datetime({ offset: true }).optional(),
    durationMinutes: z.number().int().min(5).max(600).optional(),
    recordingEnabled: z.boolean().optional(),
  })
  .refine((b) => b.classSessionId || (b.batchId && b.scheduledStartAt), {
    message: 'Provide classSessionId, or batchId with scheduledStartAt',
  });

const updateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  scheduledStartAt: z.string().datetime({ offset: true }).optional(),
  durationMinutes: z.number().int().min(5).max(600).optional(),
  recordingEnabled: z.boolean().optional(),
});

export function liveClassRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule(M));

  // Recordings (before /:id so the literal path wins)
  r.get('/recordings', can('view'), async (req, res) => {
    const q = parse(
      z.object({
        batchId: z.coerce.number().int().positive().optional(),
        liveSessionId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    res.json(await svc.listRecordings(q));
  });
  r.get('/recordings/:id/url', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { format } = parse(z.object({ format: z.enum(['hls', 'file']).optional() }), req.query);
    res.json(await svc.recordingUrl(id, format));
  });

  // Sessions
  r.get('/', can('view'), async (req, res) => {
    res.json(await svc.listSessions(parse(listQuery, req.query)));
  });
  r.post('/', can('create'), async (req, res) => {
    res.status(201).json(await svc.createSession(parse(createBody, req.body)));
  });
  r.get('/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.getSessionDto(id));
  });
  r.patch('/:id', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.updateSession(id, parse(updateBody, req.body)));
  });
  r.post('/:id/cancel', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.cancelSession(id));
  });
  r.delete('/:id', can('delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await svc.deleteSession(id);
    res.status(204).end();
  });

  // Lifecycle
  r.post('/:id/start', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.startSession(id));
  });
  r.post('/:id/end', can('edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.endSession(id));
  });
  r.post('/:id/join', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.joinInfo(id));
  });

  // History & reports
  r.get('/:id/participants', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.participationReport(id));
  });
  r.get('/:id/chat', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await svc.loadSession(id);
    res.json(await svc.listChat(id));
  });
  r.get('/:id/questions', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await svc.loadSession(id);
    res.json(await svc.listQuestions(id));
  });
  r.get('/:id/polls', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await svc.loadSession(id);
    res.json(await svc.listPolls(id));
  });

  // Recording upload from the teacher client (dev provider / client-upload mode)
  r.post('/:id/recordings', can('edit'), uploadMiddleware, async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (!req.file) throw BadRequest('Attach the recording in the `file` field');
    const { durationSeconds } = parse(
      z.object({ durationSeconds: z.coerce.number().int().min(0).optional() }),
      req.body ?? {},
    );
    const f = req.file;
    res
      .status(201)
      .json(
        await svc.uploadRecording(
          id,
          { tempPath: f.path, originalName: f.originalname, mimeType: f.mimetype, sizeBytes: f.size },
          durationSeconds ?? null,
        ),
      );
  });

  // Unauthenticated (before the authenticated router): the media provider's signed webhooks.
  api.post(
    '/live-classes/public/:provider/webhook',
    webhookRateLimit,
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const { provider } = parse(z.object({ provider: z.string().regex(/^[a-z0-9-]{1,30}$/) }), req.params);
      const raw =
        req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
      res.json(await handleProviderWebhook(provider, raw, req.get('authorization')));
    },
  );

  api.use('/live-classes', r);

  // Platform admins: media provider status, webhook URL and connection check.
  const admin = Router();
  admin.use(authenticate, requireSuperAdmin);
  admin.get('/', async (_req, res) => {
    res.json(await streamingStatus());
  });
  admin.post('/test', async (_req, res) => {
    res.json(await testStreamingConnection());
  });
  api.use('/admin/live-streaming', admin);
}
