import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { authRateLimit, tokenRateLimit } from '../../shared/middleware/security';
import { BadRequest, NotFound } from '../../shared/errors';
import { idParam } from '../../shared/utilities/pagination';
import { UserRole } from '../permissions/models';
import { assertMemberInBranchScope } from '../permissions/access.service';
import { Device } from './models';
import * as auth from './auth.service';

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

  // Own devices
  r.get('/devices', authenticate, async (req, res) => {
    const userId = req.ctx.impersonatorId ?? req.ctx.userId!;
    const rows = await Device.findAll({ where: { userId }, order: [['lastSeenAt', 'DESC']] });
    res.json(
      rows.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
        current: d.id === req.ctx.deviceId,
      })),
    );
  });

  r.delete('/devices/:id', authenticate, async (req, res) => {
    const { id } = parse(idParam, req.params);
    if (req.ctx.impersonatorId) throw BadRequest('Not available while impersonating');
    await auth.revokeDevice(id, req.ctx.userId!, req.ctx.userId!);
    res.status(204).end();
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

  // Admin revocation of a member's device (institute-scoped).
  api.delete(
    '/users/:userId/devices/:deviceId',
    authenticate,
    requirePermission('users', 'edit'),
    async (req, res) => {
      const p = parse(
        z.object({ userId: z.coerce.number().int(), deviceId: z.coerce.number().int() }),
        req.params,
      );
      const platformAdmin = req.ctx.isSuperAdmin && !req.ctx.impersonatorId;
      if (!platformAdmin) {
        const member = await UserRole.findOne({
          where: { instituteId: req.ctx.instituteId!, userId: p.userId },
        });
        if (!member) throw NotFound('User');
        await assertMemberInBranchScope(p.userId, 'manage');
      }
      await auth.revokeDevice(p.deviceId, p.userId, req.ctx.userId!);
      res.status(204).end();
    },
  );
}
