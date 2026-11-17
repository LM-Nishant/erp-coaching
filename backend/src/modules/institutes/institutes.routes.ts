import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { getStorage } from '../../infrastructure/storage';
import { Institute } from './institute.model';
import { getAllSettings, setSetting } from './settings.service';
import { FileObject } from '../files/file.model';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();

export function instituteRoutes(api: Router) {
  // ---- Public (pre-login institute selection / branding on the shared mobile app)
  api.get('/public/institutes/:slug', async (req, res) => {
    const inst = await Institute.findOne({ where: { slug: String(req.params.slug).toLowerCase(), status: 'active' } });
    if (!inst) throw NotFound('Institute');
    res.json(inst.toBranding());
  });

  api.get('/public/institutes/:slug/logo', async (req, res) => {
    const inst = await Institute.findOne({ where: { slug: String(req.params.slug).toLowerCase() } });
    if (!inst?.logoFileId) throw NotFound('Logo');
    const file = await FileObject.findOne({ where: { id: inst.logoFileId, instituteId: inst.id } });
    if (!file) throw NotFound('Logo');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    (await getStorage().getStream(file.storageKey)).pipe(res);
  });

  // ---- Current institute (tenant)
  const r = Router();
  r.use(authenticate);

  r.get('/', requirePermission('institute', 'view'), async (_req, res) => {
    const inst = await Institute.findByPk(requireTenantContext().instituteId);
    if (!inst) throw NotFound('Institute');
    res.json({ ...inst.toJSON(), branding: inst.toBranding() });
  });

  r.patch('/', requirePermission('institute', 'configure'), async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(150).optional(),
        primaryColor: color,
        secondaryColor: color,
        address: z.string().max(1000).nullable().optional(),
        city: z.string().max(80).nullable().optional(),
        state: z.string().max(80).nullable().optional(),
        registrationNumber: z.string().max(80).nullable().optional(),
        gstin: z.string().max(20).nullable().optional(),
        contactEmail: z.string().email().nullable().optional(),
        contactPhone: z.string().max(20).nullable().optional(),
        bankDetails: z.record(z.string(), z.string()).nullable().optional(),
        logoFileId: z.number().int().positive().nullable().optional(),
      }),
      req.body,
    );
    const { instituteId } = requireTenantContext();
    if (body.logoFileId) {
      const file = await FileObject.findOne({ where: { id: body.logoFileId, instituteId } });
      if (!file || !file.mimeType.startsWith('image/')) throw BadRequest('Logo must be an image uploaded to this institute');
    }
    const inst = await Institute.findByPk(instituteId);
    if (!inst) throw NotFound('Institute');
    await inst.update(body);
    await audit({ action: 'institute.profile_updated', entityType: 'institute', entityId: instituteId, metadata: { fields: Object.keys(body) } });
    res.json({ ...inst.toJSON(), branding: inst.toBranding() });
  });

  r.get('/settings', requirePermission('institute', 'view'), async (_req, res) => {
    res.json(await getAllSettings());
  });

  r.put('/settings/:key', requirePermission('institute', 'configure'), async (req, res) => {
    const key = parse(z.string().regex(/^[a-z0-9_.-]{2,120}$/), req.params.key);
    const { value } = parse(z.object({ value: z.unknown() }), req.body);
    await setSetting(key, value);
    await audit({ action: 'institute.setting_changed', entityType: 'institute_setting', entityId: key });
    res.json({ key, value });
  });

  api.use('/institute', r);
}
