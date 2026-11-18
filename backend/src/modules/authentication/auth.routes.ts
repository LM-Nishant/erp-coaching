import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireSuperAdmin } from '../../shared/middleware/authorize';
import { authRateLimit, tokenRateLimit } from '../../shared/middleware/security';
import { BadRequest, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { idParam } from '../../shared/utilities/pagination';
import { SECURE_SCREEN_NAME } from '@erp/shared';
import { User } from '../users/user.model';
import * as auth from './auth.service';
import { listUserDevices, revokeDevice, searchPlatformUsers } from './devices.service';

const device = z.object({
  uid: z.string().trim().min(8).max(128),
  name: z.string().trim().max(120).optional(),
  platform: z.enum(['web', 'android', 'ios']).optional(),
});
const mobile = z
  .string()
  .trim()
  .regex(/^\+?\d{10,15}$/, 'Invalid mobile number');

export function authRoutes(api: Router) {
  const r = Router();

  r.post('/login', authRateLimit, async (req, res) => {
    const body = parse(
      z.object({
        identifier: z.string().trim().min(3).max(150),
        password: z.string().min(1).max(200),
        device,
      }),
      req.body,
    );
    res.json(await auth.loginWithPassword(body.identifier, body.password, body.device));
  });

  r.post('/otp/request', authRateLimit, async (req, res) => {
    const body = parse(z.object({ mobile, device }), req.body);
    res.json(await auth.requestLoginOtp(body.mobile, body.device));
  });

  r.post('/otp/verify', authRateLimit, async (req, res) => {
    const body = parse(
      z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{4,8}$/), device }),
      req.body,
    );
    res.json(await auth.verifyOtp(body.challengeId, body.code, body.device));
  });

  r.post('/refresh', tokenRateLimit, async (req, res) => {
    const body = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    res.json(await auth.refreshTokens(body.refreshToken));
  });

  r.post('/logout', tokenRateLimit, async (req, res) => {
    const body = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    await auth.logout(body.refreshToken);
    res.status(204).end();
  });

  r.get('/me', authenticate, async (_req, res) => {
    res.json(await auth.buildMe());
  });

  r.post('/select-institute', authenticate, async (req, res) => {
    if (req.ctx.impersonatorId) throw BadRequest('Not available while impersonating');
    const body = parse(z.object({ instituteId: z.number().int().positive() }), req.body);
    res.json(await auth.selectInstitute(req.ctx.userId!, req.ctx.deviceId!, body.instituteId));
  });

  // Activity heartbeat: keeps the session alive while the user is active without API calls
  // (reading, watching, writing). `authenticate` records the activity.
  r.post('/activity', authenticate, (_req, res) => {
    res.status(204).end();
  });

  // The app saw a screenshot or screen recording of protected content (iOS can only detect them).
  r.post('/capture-events', authenticate, async (req, res) => {
    const body = parse(
      z.object({
        kind: z.enum(['screenshot', 'recording']),
        screens: z.array(z.string().regex(SECURE_SCREEN_NAME)).max(10),
      }),
      req.body,
    );
    await audit({
      action: body.kind === 'screenshot' ? 'device.screenshot_detected' : 'device.recording_detected',
      entityType: 'device',
      entityId: req.ctx.deviceId,
      metadata: { screens: [...new Set(body.screens)] },
    });
    res.status(204).end();
  });

  // Own devices
  r.get('/devices', authenticate, async (req, res) => {
    const userId = req.ctx.impersonatorId ?? req.ctx.userId!;
    res.json(await listUserDevices(userId, req.ctx.deviceId));
  });

  r.delete('/devices/:id', authenticate, async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (req.ctx.impersonatorId) throw BadRequest('Not available while impersonating');
    await revokeDevice(id, req.ctx.userId!, req.ctx.userId!);
    res.status(204).end();
  });

  // Biometric unlock (mobile app): enrol / remove on the current device, unlock without a session.
  r.post('/biometric', authenticate, async (_req, res) => {
    res.status(201).json(await auth.enrolBiometric());
  });

  r.delete('/biometric', authenticate, async (_req, res) => {
    await auth.removeBiometric();
    res.status(204).end();
  });

  r.post('/biometric/unlock', authRateLimit, async (req, res) => {
    const body = parse(
      z.object({
        deviceId: z.number().int().positive(),
        deviceUid: z.string().trim().min(8).max(128),
        secret: z.string().min(20).max(200),
        instituteId: z.number().int().positive().optional(),
      }),
      req.body,
    );
    res.json(await auth.unlockWithBiometric(body));
  });

  // Impersonation (super admin)
  r.post('/impersonate', authenticate, requireSuperAdmin, async (req, res) => {
    const body = parse(
      z.object({
        instituteId: z.number().int().positive(),
        userId: z.number().int().positive().optional(),
        reason: z.string().max(255).optional(),
      }),
      req.body,
    );
    res.json(await auth.startImpersonation(req.ctx.userId!, body.instituteId, body.userId, body.reason));
  });

  r.post('/impersonation/stop', authenticate, async (req, res) => {
    if (req.ctx.impersonationSessionId) await auth.stopImpersonation(req.ctx.impersonationSessionId);
    res.status(204).end();
  });

  api.use('/auth', r);

  // Super admin: devices of any user on the platform. Institute and branch admins manage their
  // members' devices through `/users/:id/devices` (users module).
  api.get('/admin/users', authenticate, requireSuperAdmin, async (req, res) => {
    const q = parse(z.object({ search: z.string().trim().min(3).max(100) }), req.query);
    res.json(await searchPlatformUsers(q.search));
  });

  api.get('/admin/users/:id/devices', authenticate, requireSuperAdmin, async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (!(await User.findByPk(id))) throw NotFound('User');
    res.json(await listUserDevices(id));
  });

  api.delete('/admin/users/:id/devices/:deviceId', authenticate, requireSuperAdmin, async (req, res) => {
    const p = parse(
      z.object({ id: z.coerce.number().int().positive(), deviceId: z.coerce.number().int().positive() }),
      req.params,
    );
    await revokeDevice(p.deviceId, p.id, req.ctx.userId!);
    res.status(204).end();
  });
}
