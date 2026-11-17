import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../../infrastructure/config';
import { getStorage } from '../../infrastructure/storage';
import { verifyFileToken } from '../../infrastructure/storage/signed-url';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireTenant } from '../../shared/middleware/authorize';
import { withContext } from '../../shared/middleware/context';
import { BadRequest, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { FileObject } from './file.model';
import { deleteFile, fileRepo, saveUploadedFile, signedUrlFor } from './files.service';

const TMP_DIR = path.resolve(__dirname, '../../../tmp/uploads');

/** Blocked outright; everything else is accepted (documents, media, images…). */
const BLOCKED_MIME = /^(application\/(x-msdownload|x-sh|x-executable|java-archive)|text\/html)/;

export const uploadMiddleware = withContext(
  multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        cb(null, TMP_DIR);
      },
    }),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1048576, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, !BLOCKED_MIME.test(file.mimetype)),
  }).single('file'),
);

export function fileRoutes(api: Router) {
  // Signed download: no session auth (token is the credential), supports Range for video seeking.
  api.get('/files/signed/:token', async (req, res) => {
    const claims = verifyFileToken(req.params.token);
    if (!claims || claims.i === null) throw NotFound('File');
    const file = await FileObject.findOne({ where: { id: claims.f, instituteId: claims.i } });
    if (!file) throw NotFound('File');
    const size = Number(file.sizeBytes);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.header('range') ?? '');
    if (range && size > 0) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
        return;
      }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      (await getStorage().getStream(file.storageKey, { start, end })).pipe(res);
      return;
    }
    res.setHeader('Content-Length', String(size));
    (await getStorage().getStream(file.storageKey)).pipe(res);
  });

  const r = Router();
  r.use(authenticate, requireTenant);

  r.post('/', requirePermission('files', 'create'), uploadMiddleware, async (req, res) => {
    if (!req.file)
      throw BadRequest('Attach a file in the `file` field (blocked types are rejected)', 'FILE_REQUIRED');
    const body = parse(
      z.object({
        module: z
          .string()
          .regex(/^[a-z0-9-]{2,60}$/)
          .default('general'),
        branchId: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const file = await saveUploadedFile({
      tempPath: req.file.path,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      module: body.module,
      branchId: body.branchId ?? null,
    });
    await audit({
      action: 'file.uploaded',
      entityType: 'file',
      entityId: file.id,
      metadata: { name: file.originalName, size: file.sizeBytes },
    });
    res.status(201).json({ ...file.toDto(), ...signedUrlFor(file) });
  });

  r.get('/', requirePermission('files', 'view'), async (req, res) => {
    const q = parse(paginationSchema.extend({ module: z.string().optional() }), req.query);
    const { rows, count } = await fileRepo.findAndCountAll({
      where: q.module ? { module: q.module } : {},
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(
      paginated(
        rows.map((f) => f.toDto()),
        count,
        q,
      ),
    );
  });

  r.get('/:id/url', requirePermission('files', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(signedUrlFor(await fileRepo.findById(id)));
  });

  r.delete('/:id', requirePermission('files', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await deleteFile(id);
    await audit({ action: 'file.deleted', entityType: 'file', entityId: id });
    res.status(204).end();
  });

  api.use('/files', r);
}
