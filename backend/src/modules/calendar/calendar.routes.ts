import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission, requireSuperAdmin } from '../../shared/middleware/authorize';
import { tokenRateLimit } from '../../shared/middleware/security';
import { parse } from '../../shared/utilities/validation';
import { idParam } from '../../shared/utilities/pagination';
import { apiBase } from './google-account';
import * as oauth from './oauth.service';
import * as svc from './connections.service';

/** The consent pages are static text: no scripts, no forms, never framed. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendConsent(res: Response, reply: oauth.ConsentReply) {
  res.setHeader('Cache-Control', 'no-store');
  const cookie = {
    httpOnly: true,
    sameSite: 'lax' as const, // sent on Google's top-level redirect back to the callback
    secure: apiBase().startsWith('https://'),
    path: oauth.CONSENT_PATH,
  };
  if (reply.setCookie)
    res.cookie(reply.setCookie.name, reply.setCookie.value, { ...cookie, maxAge: oauth.STATE_TTL_MS });
  if (reply.clearCookie) res.clearCookie(reply.clearCookie, cookie);
  if (reply.location) return res.redirect(302, reply.location);
  res.status(reply.status).setHeader('Content-Security-Policy', PAGE_CSP).type('html').send(reply.html);
}

const startQuery = z.object({ state: z.string().min(20).max(200) });
const callbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});
const connectBody = z.object({ client: z.enum(['web', 'native']).default('web') }).strict();

/**
 * Consent flow pages, opened by the browser (the system browser in the mobile app). The single-use
 * `state` created by a signed-in user is the credential; the callback also needs the cookie set by
 * the start page. See oauth.service.ts.
 */
function publicRoutes(api: Router) {
  api.get('/calendar/public/google/start', tokenRateLimit, async (req, res) => {
    const { state } = parse(startQuery, req.query);
    sendConsent(res, await oauth.beginConsent(state, req.headers.cookie));
  });

  api.get('/calendar/public/google/callback', tokenRateLimit, async (req, res) => {
    sendConsent(res, await oauth.completeConsent(parse(callbackQuery, req.query), req.headers.cookie));
  });
}

/** A teacher's own Google Calendar (their appointments go there instead of the organiser's). */
function myRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule('appointments'));
  const own = requirePermission('appointments', 'edit');

  r.get('/', own, async (_req, res) => {
    res.json(await svc.myCalendar());
  });

  r.post('/connect', own, async (req, res) => {
    const { client } = parse(connectBody, req.body ?? {});
    res.json(await oauth.startConnect('me', client));
  });

  r.post('/test', own, async (_req, res) => {
    res.json(await svc.testMyCalendar());
  });

  r.delete('/', own, async (_req, res) => {
    await svc.disconnectMyCalendar();
    res.status(204).end();
  });

  api.use('/calendar/me', r);
}

/** Institute admins: the organiser calendar, and every teacher's connection. */
function instituteRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireModule('appointments'));
  const configure = requirePermission('institute', 'configure');

  r.get('/settings', configure, async (_req, res) => {
    res.json(await svc.calendarSettings());
  });

  r.post('/organiser/connect', configure, async (req, res) => {
    const { client } = parse(connectBody, req.body ?? {});
    res.json(await oauth.startConnect('organiser', client));
  });

  r.post('/connections/:id/test', configure, async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await svc.testCalendarConnection(id));
  });

  r.delete('/connections/:id', configure, async (req, res) => {
    const { id } = parse(idParam, req.params);
    await svc.disconnectCalendarConnection(id);
    res.status(204).end();
  });

  api.use('/calendar', r);
}

/** Super admin: the platform's Google OAuth client. */
function platformRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireSuperAdmin);

  r.get('/', async (_req, res) => {
    res.json(await svc.platformCalendarStatus());
  });

  r.post('/test', async (_req, res) => {
    res.json(await svc.testPlatformCalendar());
  });

  api.use('/admin/calendar', r);
}

export function calendarRoutes(api: Router) {
  // Order matters: the authenticated routers below would otherwise catch the public pages.
  publicRoutes(api);
  myRoutes(api);
  instituteRoutes(api);
  platformRoutes(api);
}
