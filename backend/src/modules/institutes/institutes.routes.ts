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
import { clearInstituteTimezoneCache, getInstituteTimezone, isValidTimeZone } from '../../shared/timezone';
import { clearIdleTimeoutCache, getIdleTimeoutMinutes } from '../../shared/session-policy';
import {
  INSTITUTE_IDLE_TIMEOUT_SETTING,
  INSTITUTE_TIMEZONE_SETTING,
  isValidIdleTimeout,
  type InstituteSettingsDto,
} from '@erp/shared';
import { setFileResponseHeaders } from '../../shared/utilities/file-response';
import { FileObject } from '../files/file.model';
import { setupStatus } from './setup-status';

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable()
  .optional();

const timezone = z.string().max(64).refine(isValidTimeZone, 'Unknown IANA timezone');

async function saveTimezone(tz: string) {
  await setSetting(INSTITUTE_TIMEZONE_SETTING, tz);
  clearInstituteTimezoneCache(requireTenantContext().instituteId);
}

/** Inactivity logout for web and app sessions (spec 4.18): 0 (never) or 5–1440 minutes. */
const idleTimeout = z
  .number()
  .int()
  .refine(isValidIdleTimeout, 'Use 0 (never) or between 5 and 1440 minutes');

async function saveIdleTimeout(minutes: number) {
  await setSetting(INSTITUTE_IDLE_TIMEOUT_SETTING, minutes);
  clearIdleTimeoutCache(requireTenantContext().instituteId);
}

async function profileDto(inst: Institute) {
  return {
    ...inst.toJSON(),
    timezone: await getInstituteTimezone(inst.id),
    idleTimeoutMinutes: await getIdleTimeoutMinutes(inst.id),
    branding: inst.toBranding(),
  };
}

export function instituteRoutes(api: Router) {
  // ---- Public (pre-login institute selection / branding on the shared mobile app)
  api.get('/public/institutes/:slug', async (req, res) => {
    const inst = await Institute.findOne({
      where: { slug: String(req.params.slug).toLowerCase(), status: 'active' },
    });
    if (!inst) throw NotFound('Institute');
    res.json(inst.toBranding());
  });

  api.get('/public/institutes/:slug/logo', async (req, res) => {
    const inst = await Institute.findOne({ where: { slug: String(req.params.slug).toLowerCase() } });
    if (!inst?.logoFileId) throw NotFound('Logo');
    const file = await FileObject.findOne({ where: { id: inst.logoFileId, instituteId: inst.id } });
    if (!file) throw NotFound('Logo');
    setFileResponseHeaders(res, file, 'public, max-age=86400');
    (await getStorage().getStream(file.storageKey)).pipe(res);
  });

  // ---- Current institute (tenant)
  const r = Router();
  r.use(authenticate);

  r.get('/', requirePermission('institute', 'view'), async (_req, res) => {
    const inst = await Institute.findByPk(requireTenantContext().instituteId);
    if (!inst) throw NotFound('Institute');
    res.json(await profileDto(inst));
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
        timezone: timezone.optional(),
        idleTimeoutMinutes: idleTimeout.optional(),
      }),
      req.body,
    );
    const { instituteId } = requireTenantContext();
    const { timezone: tz, idleTimeoutMinutes, ...profile } = body;
    if (body.logoFileId) {
      const file = await FileObject.findOne({ where: { id: body.logoFileId, instituteId } });
      if (!file || !file.mimeType.startsWith('image/'))
        throw BadRequest('Logo must be an image uploaded to this institute');
    }
    const inst = await Institute.findByPk(instituteId);
    if (!inst) throw NotFound('Institute');
    await inst.update(profile);
    if (tz) await saveTimezone(tz);
    if (idleTimeoutMinutes !== undefined) await saveIdleTimeout(idleTimeoutMinutes);
    await audit({
      action: 'institute.profile_updated',
      entityType: 'institute',
      entityId: instituteId,
      metadata: {
        fields: Object.keys(body),
        ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
      },
    });
    res.json(await profileDto(inst));
  });

  /** New-institute checklist for the staff home (course → batch → fees → people → payments). */
  r.get('/setup-status', requirePermission('institute', 'configure'), async (_req, res) => {
    res.json(await setupStatus(requireTenantContext().instituteId));
  });

  r.get('/settings', requirePermission('institute', 'view'), async (_req, res) => {
    const dto: InstituteSettingsDto = { ...(await getAllSettings()), timezone: await getInstituteTimezone() };
    res.json(dto);
  });

  r.put('/settings/:key', requirePermission('institute', 'configure'), async (req, res) => {
    const key = parse(z.string().regex(/^[a-z0-9_.-]{2,120}$/), req.params.key);
    const { value } = parse(z.object({ value: z.unknown() }), req.body);
    if (key === INSTITUTE_TIMEZONE_SETTING) await saveTimezone(parse(timezone, value));
    else if (key === INSTITUTE_IDLE_TIMEOUT_SETTING) await saveIdleTimeout(parse(idleTimeout, value));
    else await setSetting(key, value);
    await audit({
      action: 'institute.setting_changed',
      entityType: 'institute_setting',
      entityId: key,
      ...(key === INSTITUTE_IDLE_TIMEOUT_SETTING ? { metadata: { value } } : {}),
    });
    res.json({ key, value });
  });

  api.use('/institute', r);
}
