import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config, DEFAULT_DEMO_PASSWORD, DEFAULT_SUPERADMIN_PASSWORD } from '../src/infrastructure/config';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { assertSafeForProduction } from '../src/infrastructure/database/seeders/20261117000100-demo-data';
import {
  captureError,
  setErrorTracker,
  WebhookErrorTracker,
  type TrackedError,
} from '../src/infrastructure/error-tracking';
import { logger, redactUrl } from '../src/infrastructure/logger';
import { consoleOutbox } from '../src/infrastructure/messaging';
import { ConsoleMessagingProvider } from '../src/infrastructure/messaging/console.provider';
import { runWithContext } from '../src/shared/context';
import { NotFound } from '../src/shared/errors';
import { resolveRequestId } from '../src/shared/middleware/context';
import { errorHandler } from '../src/shared/middleware/error-handler';
import {
  contentDisposition,
  fileServePolicy,
  isBlockedUploadType,
} from '../src/shared/utilities/file-response';
import { getApp } from './helpers';
import {
  createInstitute,
  createSuperAdmin,
  mobileFactory,
  purgeInstitutes,
  send,
  upload,
  type Tenant,
} from './security/harness';

/** Operational guarantees added for production: probes, logging, error tracking, served uploads, limiters. */
const MOBILE_PREFIX = '9454';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setErrorTracker(null);
});

describe('health and readiness probes', () => {
  it('answers liveness and readiness without caching', async () => {
    const app = await getApp();
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(health.headers['cache-control']).toBe('no-store');

    const ready = await request(app).get('/api/ready');
    expect(ready.status).toBe(200);
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.body).toMatchObject({
      status: 'ready',
      checks: {
        database: { ok: true },
        migrations: { ok: true, pending: 0 },
        storage: { ok: true, driver: 'local' },
      },
    });
  });

  it('reports not ready (503) while the database is unreachable', async () => {
    const app = await getApp();
    vi.spyOn(getSequelize(), 'query').mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'not_ready',
      checks: { database: { ok: false }, migrations: { ok: false } },
    });
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});

describe('request ids and log redaction', () => {
  it('keeps a well-formed X-Request-Id and replaces anything else', async () => {
    expect(resolveRequestId('lb-7f3a.01:9_x')).toBe('lb-7f3a.01:9_x');
    for (const bad of ['has space', '<script>', 'x'.repeat(65), '', ['a', 'b'], undefined])
      expect(resolveRequestId(bad)).toMatch(UUID);

    const app = await getApp();
    const kept = await request(app).get('/api/health').set('X-Request-Id', 'edge-123');
    expect(kept.headers['x-request-id']).toBe('edge-123');
    const replaced = await request(app).get('/api/health').set('X-Request-Id', '"><img src=x>');
    expect(replaced.headers['x-request-id']).toMatch(UUID);
  });

  it('strips signed tokens, webhook keys and one-time codes from logged URLs', () => {
    expect(redactUrl('/api/files/signed/eyJmIjo.abc123?download=1')).toBe(
      '/api/files/signed/[redacted]?download=1',
    );
    expect(redactUrl('/api/lms/public/hls/tok.sig/seg-001.ts')).toBe(
      '/api/lms/public/hls/[redacted]/seg-001.ts',
    );
    expect(redactUrl('/api/fees/public/webhooks/razorpay/whk_secret')).toBe(
      '/api/fees/public/webhooks/razorpay/[redacted]',
    );
    expect(redactUrl('/api/notifications/public/webhooks/msg91/dlr_secret')).toBe(
      '/api/notifications/public/webhooks/msg91/[redacted]',
    );
    expect(
      redactUrl(
        '/api/notifications/public/webhooks/whatsapp-cloud/wa_secret?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42',
      ),
    ).toBe(
      '/api/notifications/public/webhooks/whatsapp-cloud/[redacted]?hub.mode=subscribe&hub.verify_token=[redacted]&hub.challenge=42',
    );
    expect(redactUrl('/api/x?page=2&token=abc&OTP=123456&code=9')).toBe(
      '/api/x?page=2&token=[redacted]&OTP=[redacted]&code=[redacted]',
    );
    expect(redactUrl('/api/students?page=2')).toBe('/api/students?page=2');
  });

  it('never logs or keeps message bodies such as OTPs from the console provider in production', async () => {
    const sms = new ConsoleMessagingProvider('sms');
    const message = { to: '9454999999', body: '482913 is your verification code.', data: { otp: '482913' } };
    const info = vi.spyOn(logger, 'info');
    const kept = consoleOutbox.length;
    const wasProd = config.isProd;
    try {
      Object.assign(config, { isProd: true });
      await expect(sms.send(message)).resolves.toMatchObject({ status: 'sent' });
      await sms.send({ ...message, to: 'parent@example.com', subject: 'Result for Asha' });
    } finally {
      Object.assign(config, { isProd: wasProd });
    }
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('***9999');
    expect(logged).toContain('***@example.com');
    for (const secret of ['482913', '9454999999', 'parent@', 'Asha']) expect(logged).not.toContain(secret);
    expect(consoleOutbox.length).toBe(kept);

    await sms.send(message);
    expect(consoleOutbox.at(-1)).toMatchObject({ to: '9454999999', body: message.body });
    expect(JSON.stringify(info.mock.calls)).toContain('482913');
  });
});

describe('error tracking', () => {
  it('reports 5xx errors with the route pattern only, never 4xx', async () => {
    const events: TrackedError[] = [];
    setErrorTracker({ name: 'test', capture: (e) => events.push(e), flush: async () => undefined });
    const app = express();
    app.get('/api/things/:token', () => {
      throw new Error('boom');
    });
    app.get('/api/missing', () => {
      throw NotFound('Thing');
    });
    app.use(errorHandler);

    const res = await request(app).get('/api/things/s3cr3t-token');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
    expect(events).toHaveLength(1);
    expect(events[0].tags).toEqual({ method: 'GET', route: '/api/things/:token', status: 500 });
    expect((events[0].error as Error).message).toBe('boom');

    expect((await request(app).get('/api/missing')).status).toBe(404);
    expect(events).toHaveLength(1);
  });

  it('never lets a failing tracker break the caller', () => {
    setErrorTracker({
      name: 'broken',
      capture: () => {
        throw new Error('collector down');
      },
      flush: async () => undefined,
    });
    expect(() => captureError(new Error('original'))).not.toThrow();
  });

  it('webhook adapter posts JSON events with context and caps them per minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const tracker = new WebhookErrorTracker('https://collector.example/hook', 2);
    const body = (call: number) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body));

    runWithContext({ requestId: 'req-1', instituteId: 7, userId: 9 }, () =>
      tracker.capture({ error: new TypeError('bad thing'), level: 'error', tags: { route: '/api/x' } }),
    );
    tracker.capture({ error: 'plain string', level: 'fatal' });
    tracker.capture({ error: new Error('over the cap'), level: 'error' });
    await tracker.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://collector.example/hook');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(body(0)).toMatchObject({
      level: 'error',
      environment: 'test',
      error: { type: 'TypeError', message: 'bad thing' },
      tags: { requestId: 'req-1', instituteId: 7, userId: 9, route: '/api/x' },
      droppedSinceLast: 0,
    });
    expect(body(1)).toMatchObject({ level: 'fatal', error: { type: 'string', message: 'plain string' } });

    vi.setSystemTime(new Date('2030-01-01T00:01:00Z'));
    tracker.capture({ error: new Error('next minute'), level: 'error' });
    await tracker.flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(body(2)).toMatchObject({ error: { message: 'next minute' }, droppedSinceLast: 1 });
  });
});

describe('served uploads', () => {
  const nextMobile = mobileFactory('4');
  let tenant: Tenant;

  beforeAll(async () => {
    const superAdmin = await createSuperAdmin(nextMobile());
    const slug = `rr-${Date.now().toString(36)}`;
    tenant = await createInstitute(superAdmin, {
      slug,
      name: `Release Readiness ${slug}`,
      adminMobile: nextMobile(),
      label: 'release-readiness admin',
    });
  });

  afterAll(async () => {
    await purgeInstitutes(tenant ? [tenant.id] : [], MOBILE_PREFIX);
  });

  it('only lets passive types render inline, sandboxing documents', () => {
    expect(fileServePolicy('image/png')).toEqual({ contentType: 'image/png', inline: true, sandbox: true });
    expect(fileServePolicy('Image/SVG+XML; charset=utf-8')).toEqual({
      contentType: 'image/svg+xml',
      inline: true,
      sandbox: true,
    });
    expect(fileServePolicy('application/pdf')).toEqual({
      contentType: 'application/pdf',
      inline: true,
      sandbox: false,
    });
    expect(fileServePolicy('video/mp4')).toMatchObject({ inline: true, sandbox: false });
    expect(fileServePolicy('text/html')).toEqual({
      contentType: 'text/plain; charset=utf-8',
      inline: true,
      sandbox: true,
    });
    for (const risky of ['application/javascript', 'image/png"><script>', '', null])
      expect(fileServePolicy(risky)).toEqual({
        contentType: 'application/octet-stream',
        inline: false,
        sandbox: true,
      });

    for (const blocked of [
      'text/html',
      'TEXT/HTML; charset=utf-8',
      'application/xhtml+xml',
      'application/x-msdownload',
    ])
      expect(isBlockedUploadType(blocked)).toBe(true);
    for (const allowed of ['image/svg+xml', 'application/pdf', 'text/plain', 'video/mp4'])
      expect(isBlockedUploadType(allowed)).toBe(false);
  });

  it('builds a header-safe Content-Disposition', () => {
    expect(contentDisposition('attachment', 'résumé "final".pdf')).toBe(
      `attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
    expect(contentDisposition('inline', 'a\r\nSet-Cookie: x=1')).not.toMatch(/[\r\n]/);
    expect(contentDisposition('inline', '')).toBe(`inline; filename="download"; filename*=UTF-8''download`);
  });

  it('lets the app frame stored PDFs and read download file names cross-origin', async () => {
    const pdf = await upload(
      tenant.admin,
      '/api/files',
      { name: 'notes.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n') },
      { module: 'general' },
    );
    const res = await request(await getApp())
      .get(new URL(pdf.url).pathname)
      .set('Origin', 'capacitor://localhost');
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBeUndefined();
    const ancestors = String(res.headers['content-security-policy'])
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.startsWith('frame-ancestors'));
    expect(ancestors).toHaveLength(1);
    for (const origin of ["'self'", 'capacitor://localhost', 'https://localhost', config.publicWebUrl])
      expect(ancestors[0].split(' ')).toContain(origin);
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="notes.pdf"/);
  });

  it('serves uploads with safe headers through short-lived signed URLs', async () => {
    const svg = await upload(
      tenant.admin,
      '/api/files',
      {
        name: 'logo.svg',
        type: 'image/svg+xml',
        data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      },
      { module: 'general' },
    );
    const svgPath = new URL(svg.url).pathname;
    const image = await send(null, 'GET', svgPath);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/svg+xml');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['content-security-policy']).toContain('sandbox');
    expect(image.headers['content-disposition']).toMatch(/^inline;/);

    const js = await upload(
      tenant.admin,
      '/api/files',
      { name: 'app.js', type: 'application/javascript', data: Buffer.from('alert(document.cookie)') },
      { module: 'general' },
    );
    const script = await send(null, 'GET', new URL(js.url).pathname);
    expect(script.headers['content-type']).toBe('application/octet-stream');
    expect(script.headers['content-disposition']).toMatch(/^attachment;/);

    const htmlUpload = await request(await getApp())
      .post('/api/files')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('module', 'general')
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'x.html',
        contentType: 'text/html',
      });
    expect(htmlUpload.status).toBe(400);
    expect(htmlUpload.body.error.message).toMatch(/blocked types are rejected/);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (config.SIGNED_URL_TTL_SECONDS + 1) * 1000);
    expect((await send(null, 'GET', svgPath)).status).toBe(404);
  });
});

describe('production seeding guard', () => {
  it('refuses the README passwords in production', () => {
    const saved = {
      isProd: config.isProd,
      SEED_SUPERADMIN_PASSWORD: config.SEED_SUPERADMIN_PASSWORD,
      SEED_DEMO_DATA: config.SEED_DEMO_DATA,
      SEED_DEMO_PASSWORD: config.SEED_DEMO_PASSWORD,
    };
    try {
      Object.assign(config, { isProd: true, SEED_DEMO_DATA: false });
      config.SEED_SUPERADMIN_PASSWORD = DEFAULT_SUPERADMIN_PASSWORD;
      expect(assertSafeForProduction).toThrow(/SEED_SUPERADMIN_PASSWORD/);
      config.SEED_SUPERADMIN_PASSWORD = 'short-1';
      expect(assertSafeForProduction).toThrow(/SEED_SUPERADMIN_PASSWORD/);
      config.SEED_SUPERADMIN_PASSWORD = 'a-long-unique-passphrase';
      expect(assertSafeForProduction).not.toThrow();
      Object.assign(config, { SEED_DEMO_DATA: true, SEED_DEMO_PASSWORD: DEFAULT_DEMO_PASSWORD });
      expect(assertSafeForProduction).toThrow(/SEED_DEMO_PASSWORD/);
    } finally {
      Object.assign(config, saved);
    }
  });
});

describe('rate limiters', () => {
  const env = {
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_AUTH_MAX: '2',
    RATE_LIMIT_PUBLIC_FORM_MAX: '1',
    RATE_LIMIT_API_PER_MIN: '1',
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  it('give each kind of traffic its own per-IP budget and skip media for the API limit', async () => {
    // The limiters read their settings when loaded, so load a fresh copy with limiting enabled.
    Object.assign(process.env, env);
    vi.resetModules();
    const limits = await import('../src/shared/middleware/security');
    const app = express();
    app.post('/auth/login', limits.authRateLimit, (_req, res) => res.json({ ok: true }));
    app.post('/public/form', limits.publicFormRateLimit, (_req, res) => res.json({ ok: true }));
    const api = express.Router();
    api.use(limits.apiRateLimit);
    api.get('/files/signed/:token', (_req, res) => res.json({ ok: true }));
    api.get('/students', (_req, res) => res.json({ ok: true }));
    app.use('/api', api);

    expect((await request(app).post('/auth/login')).status).toBe(200);
    expect((await request(app).post('/auth/login')).status).toBe(200);
    const limited = await request(app).post('/auth/login');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } });
    expect(limited.headers['ratelimit-policy']).toBeDefined();

    expect((await request(app).post('/public/form')).status).toBe(200);
    expect((await request(app).post('/public/form')).status).toBe(429);

    expect((await request(app).get('/api/students')).status).toBe(200);
    expect((await request(app).get('/api/students')).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await request(app).get('/api/files/signed/t')).status).toBe(200);
  });
});
