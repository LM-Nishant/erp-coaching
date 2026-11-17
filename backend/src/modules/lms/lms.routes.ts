import express, { Router } from 'express';
import { z } from 'zod';
import {
  LMS_ACCESS_TYPES,
  LMS_ASSIGNMENT_STATUSES,
  LMS_MAX_UPLOAD_BYTES,
  LMS_RESOURCE_STATUSES,
  LMS_RESOURCE_TYPES,
  LMS_UPLOAD_CHUNK_BYTES,
} from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginationSchema } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission } from '../../shared/middleware/authorize';
import { withContext } from '../../shared/middleware/context';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { BadRequest, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { saveUploadedFile } from '../files/files.service';
import { uploadMiddleware } from '../files/files.routes';
import { getLinkedStudentUsers } from '../guardians/guardian-access';
import * as res$ from './resources.service';
import * as asg from './assignments.service';
import * as up from './uploads.service';
import { verifyStreamToken } from './stream-token';
import { openHlsFile } from './transcode.job';

export const LMS = 'lms';
export const LMS_ASSIGNMENTS = 'lms-assignments';
const can = (action: Parameters<typeof requirePermission>[1]) => requirePermission(LMS, action);
const canHw = (action: Parameters<typeof requirePermission>[1]) => requirePermission(LMS_ASSIGNMENTS, action);

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const optId = z.number().int().positive().nullable().optional();
const optDate = z.coerce.date().nullable().optional();
const qId = z.coerce.number().int().positive().optional();

const resourceFields = {
  courseId: z.number().int().positive(),
  subjectId: optId,
  chapterId: optId,
  topicId: optId,
  branchId: optId,
  batchIds: z.array(z.number().int().positive()).max(200).optional(),
  title: text(200),
  description: optText(5000),
  type: z.enum(LMS_RESOURCE_TYPES),
  fileId: optId,
  externalUrl: z.string().trim().url().max(1000).nullable().optional(),
  durationSeconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600)
    .nullable()
    .optional(),
  access: z.enum(LMS_ACCESS_TYPES).optional(),
  accessDays: z.number().int().min(1).max(3650).nullable().optional(),
  availableFrom: optDate,
  availableUntil: optDate,
  downloadable: z.boolean().optional(),
  offlineAllowed: z.boolean().optional(),
  offlineExpiryHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
};
const resourceBody = z.object(resourceFields);
const resourcePatch = z.object(resourceFields).partial();

const assignmentFields = {
  batchId: z.number().int().positive(),
  subjectId: optId,
  chapterId: optId,
  topicId: optId,
  title: text(200),
  instructions: optText(10000),
  dueAt: z.coerce.date(),
  maxMarks: z.number().min(0).max(10000).nullable().optional(),
  allowLate: z.boolean().optional(),
  fileIds: z.array(z.number().int().positive()).max(20).optional(),
};
const assignmentBody = z.object(assignmentFields);
const assignmentPatch = z.object(assignmentFields).partial();

const uploadIdParam = z.object({ uploadId: z.string().uuid() });

/** Raw-body parser for upload chunks (the global JSON limit is much smaller). */
const chunkBody = withContext(
  express.raw({ type: () => true, limit: LMS_UPLOAD_CHUNK_BYTES + 1024 }) as express.RequestHandler,
);

/** Uploading content is allowed to anyone who can author resources or submit/author homework. */
function canUpload() {
  if (
    !['lms.create', 'lms.edit', 'lms-assignments.create', 'lms-assignments.edit'].some((k) =>
      hasPermission(k),
    )
  )
    throw Forbidden();
}

const HLS_NAME = /^(index\.m3u8|seg_\d{1,6}\.ts)$/;

export function lmsRoutes(api: Router) {
  // ------------------------------------------------------------------------------------------
  // Public: HLS playlist/segments authorised by a short-lived stream token (no session header,
  // because <video>/native players fetch segments themselves). Segment URLs are relative.
  // ------------------------------------------------------------------------------------------
  api.get('/lms/public/hls/:token/:name', async (req, res) => {
    const claims = verifyStreamToken(req.params.token as string);
    const name = req.params.name as string;
    if (!claims || !HLS_NAME.test(name)) throw NotFound('Stream');
    const f = await openHlsFile(claims.i, claims.r, name);
    if (!f) throw NotFound('Stream');
    res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    f.stream.pipe(res);
  });

  const r = Router();
  r.use(authenticate, requireModule(LMS));

  // ---------------------------------------------------------------- uploads
  r.post('/files', uploadMiddleware, async (req, res) => {
    canUpload();
    if (!req.file) throw BadRequest('Attach a file in the `file` field (blocked types are rejected)');
    const body = parse(z.object({ branchId: z.coerce.number().int().positive().optional() }), req.body);
    const file = await saveUploadedFile({
      tempPath: req.file.path,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      module: LMS,
      branchId: body.branchId ?? null,
    });
    await audit({ action: 'lms.file.uploaded', entityType: 'file', entityId: file.id });
    res.status(201).json(up.fileRef(file, true));
  });

  r.post('/uploads', async (req, res) => {
    canUpload();
    const body = parse(
      z.object({
        fileName: text(255),
        mimeType: z.string().trim().min(3).max(120),
        totalBytes: z.number().int().positive().max(LMS_MAX_UPLOAD_BYTES),
        branchId: optId,
      }),
      req.body,
    );
    res.status(201).json(await up.startUpload(body));
  });
  r.get('/uploads/:uploadId', async (req, res) => {
    res.json(await up.getUpload(parse(uploadIdParam, req.params).uploadId));
  });
  r.put('/uploads/:uploadId/chunk', chunkBody, async (req, res) => {
    const { uploadId } = parse(uploadIdParam, req.params);
    const { offset } = parse(z.object({ offset: z.coerce.number().int().min(0) }), req.query);
    if (!Buffer.isBuffer(req.body)) throw BadRequest('Send the chunk as application/octet-stream');
    res.json(await up.appendChunk(uploadId, offset, req.body));
  });
  r.post('/uploads/:uploadId/complete', async (req, res) => {
    res.json(await up.completeUpload(parse(uploadIdParam, req.params).uploadId));
  });
  r.delete('/uploads/:uploadId', async (req, res) => {
    await up.abortUpload(parse(uploadIdParam, req.params).uploadId);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- staff: content management
  r.get('/resources', can('edit'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        courseId: qId,
        subjectId: qId,
        chapterId: qId,
        topicId: qId,
        type: z.enum(LMS_RESOURCE_TYPES).optional(),
        status: z.enum(LMS_RESOURCE_STATUSES).optional(),
      }),
      req.query,
    );
    res.json(await res$.listResources(q));
  });
  r.post('/resources', can('create'), async (req, res) => {
    res.status(201).json(await res$.createResource(parse(resourceBody, req.body)));
  });
  r.get('/resources/:id', can('view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(res$.isStaff() ? await res$.getResource(id) : await res$.learnerResourceDetail(id));
  });
  r.patch('/resources/:id', can('edit'), async (req, res) => {
    res.json(await res$.updateResource(parse(idParam, req.params).id, parse(resourcePatch, req.body)));
  });
  r.delete('/resources/:id', can('delete'), async (req, res) => {
    await res$.deleteResource(parse(idParam, req.params).id);
    res.status(204).end();
  });
  r.post('/resources/:id/publish', can('publish'), async (req, res) => {
    res.json(await res$.setResourceStatus(parse(idParam, req.params).id, 'published'));
  });
  r.post('/resources/:id/unpublish', can('publish'), async (req, res) => {
    res.json(await res$.setResourceStatus(parse(idParam, req.params).id, 'draft'));
  });
  r.post('/resources/:id/archive', can('publish'), async (req, res) => {
    res.json(await res$.setResourceStatus(parse(idParam, req.params).id, 'archived'));
  });
  r.post('/resources/:id/transcode', can('edit'), async (req, res) => {
    res.json(await res$.requestTranscode(parse(idParam, req.params).id));
  });
  r.get('/resources/:id/analytics', can('edit'), async (req, res) => {
    res.json(await res$.resourceAnalytics(parse(idParam, req.params).id));
  });

  // ---------------------------------------------------------------- learners
  r.get('/library', can('view'), async (_req, res) => {
    res.json(await res$.learnerLibrary());
  });
  r.get('/courses/:id/contents', can('view'), async (req, res) => {
    res.json(await res$.courseContents(parse(idParam, req.params).id));
  });
  r.post('/resources/:id/play', can('view'), async (req, res) => {
    const { prefer } = parse(z.object({ prefer: z.enum(['hls', 'mp4']).optional() }), req.body ?? {});
    res.json(await res$.play(parse(idParam, req.params).id, prefer));
  });
  r.post('/resources/:id/download', can('view'), async (req, res) => {
    res.json(await res$.downloadLink(parse(idParam, req.params).id));
  });
  r.put('/resources/:id/progress', can('view'), async (req, res) => {
    const body = parse(
      z.object({
        positionSeconds: z
          .number()
          .min(0)
          .max(24 * 3600),
        durationSeconds: z
          .number()
          .min(0)
          .max(24 * 3600)
          .nullable()
          .optional(),
        watchedDeltaSeconds: z.number().min(0).max(3600).optional(),
        completed: z.boolean().optional(),
      }),
      req.body,
    );
    if (res$.isStaff()) throw Forbidden('Progress is tracked for learners only', 'LMS_STAFF_PREVIEW');
    res.json(await res$.recordProgress(parse(idParam, req.params).id, body));
  });
  r.post('/resources/:id/offline-license', can('view'), async (req, res) => {
    res.status(201).json(await res$.issueOfflineLicense(parse(idParam, req.params).id));
  });
  r.get('/offline-licenses', can('view'), async (_req, res) => {
    res.json(await res$.listOfflineLicenses());
  });
  r.delete('/offline-licenses/:id', can('view'), async (req, res) => {
    await res$.revokeOfflineLicense(parse(idParam, req.params).id);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- parents
  r.get('/children', can('view'), async (_req, res) => {
    const { userId, instituteId } = requireTenantContext();
    const children = await getLinkedStudentUsers(userId!, instituteId);
    const out = [];
    for (const c of children)
      out.push({ student: { id: c.id, name: c.name }, courses: await res$.learnerLibrary(c.id) });
    res.json(out);
  });

  // ---------------------------------------------------------------- manual access grants
  r.get('/grants', can('configure'), async (req, res) => {
    res.json(
      await res$.listGrants(parse(paginationSchema.extend({ courseId: qId, studentUserId: qId }), req.query)),
    );
  });
  r.post('/grants', can('configure'), async (req, res) => {
    const body = parse(
      z.object({
        studentUserId: z.number().int().positive(),
        courseId: z.number().int().positive(),
        validUntil: optDate,
        note: optText(500),
      }),
      req.body,
    );
    res.status(201).json(await res$.createGrant(body));
  });
  r.delete('/grants/:id', can('configure'), async (req, res) => {
    await res$.revokeGrant(parse(idParam, req.params).id);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- homework
  const hwStatus = z.enum(['pending', 'done']).optional();
  r.get('/assignments', canHw('view'), async (req, res) => {
    if (hasPermission('lms-assignments.edit')) {
      const q = parse(
        paginationSchema.extend({ batchId: qId, status: z.enum(LMS_ASSIGNMENT_STATUSES).optional() }),
        req.query,
      );
      res.json(await asg.listAssignments(q));
      return;
    }
    const q = parse(z.object({ status: hwStatus }), req.query);
    const items = await asg.myAssignments(q);
    res.json({ items, total: items.length, page: 1, pageSize: items.length });
  });
  r.get('/assignments/children', canHw('view'), async (req, res) => {
    const q = parse(z.object({ status: hwStatus, studentUserId: qId }), req.query);
    res.json(await asg.childrenAssignments(q));
  });
  r.post('/assignments', canHw('edit'), async (req, res) => {
    res.status(201).json(await asg.createAssignment(parse(assignmentBody, req.body)));
  });
  r.get('/assignments/:id', canHw('view'), async (req, res) => {
    res.json(await asg.getAssignment(parse(idParam, req.params).id));
  });
  r.patch('/assignments/:id', canHw('edit'), async (req, res) => {
    res.json(await asg.updateAssignment(parse(idParam, req.params).id, parse(assignmentPatch, req.body)));
  });
  r.delete('/assignments/:id', canHw('delete'), async (req, res) => {
    await asg.deleteAssignment(parse(idParam, req.params).id);
    res.status(204).end();
  });
  r.post('/assignments/:id/publish', canHw('publish'), async (req, res) => {
    res.json(await asg.publishAssignment(parse(idParam, req.params).id));
  });
  r.post('/assignments/:id/close', canHw('publish'), async (req, res) => {
    res.json(await asg.closeAssignment(parse(idParam, req.params).id));
  });
  r.get('/assignments/:id/submissions', canHw('edit'), async (req, res) => {
    res.json(await asg.listSubmissions(parse(idParam, req.params).id));
  });
  r.put('/assignments/:id/submission', canHw('create'), async (req, res) => {
    asg.assertCanSubmit();
    const body = parse(
      z.object({ text: optText(20000), fileIds: z.array(z.number().int().positive()).max(10).optional() }),
      req.body,
    );
    res.json(await asg.submitAssignment(parse(idParam, req.params).id, body));
  });
  r.post('/submissions/:id/grade', canHw('edit'), async (req, res) => {
    const body = parse(
      z.object({
        marks: z.number().min(0).max(10000).nullable().optional(),
        feedback: optText(5000),
        status: z.enum(['graded', 'returned']).optional(),
      }),
      req.body,
    );
    res.json(await asg.gradeSubmission(parse(idParam, req.params).id, body));
  });

  api.use('/lms', r);
}
