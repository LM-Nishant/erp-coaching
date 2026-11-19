import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { config } from './infrastructure/config';
import { logger, redactUrl } from './infrastructure/logger';
import { readiness } from './infrastructure/health';
import { contextMiddleware, resolveRequestId } from './shared/middleware/context';
import { apiRateLimit } from './shared/middleware/security';
import { errorHandler, notFoundHandler } from './shared/middleware/error-handler';
import type { ModuleDefinition } from './shared/module';

const PROBE_PATHS = new Set(['/api/health', '/api/ready']);
/** ZKTeco/eSSL ADMS devices call fixed paths at the server root (some firmware adds `.aspx`). */
const ICLOCK_PATH = /^\/iclock\/(cdata|fdata|getrequest|devicecmd|ping)(?:\.aspx)?(?=\?|$)/i;

export function createApp(modules: ModuleDefinition[]) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  // Served by the attendance module under /api, so API limits and the error handler apply.
  app.use((req, _res, next) => {
    const m = ICLOCK_PATH.exec(req.url);
    if (m) {
      req.url = `/api/attendance/public/iclock/${m[1].toLowerCase()}${req.url.slice(m[0].length)}`;
      // Device bodies are text or gzip whatever their label says; the ADMS router reads them as bytes.
      if (req.headers['content-type']) req.headers['content-type'] = 'application/octet-stream';
    }
    next();
  });
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Content-Range', 'Accept-Ranges', 'Content-Disposition'],
    }),
  );
  app.use(
    express.json({
      limit: '1mb',
      // Keep the exact bytes so payment webhooks can verify vendor signatures.
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );
  if (!config.isTest)
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => resolveRequestId(req.headers['x-request-id']),
        autoLogging: { ignore: (req) => PROBE_PATHS.has((req.url ?? '').split('?')[0]) },
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
        serializers: {
          req: (req: { id: unknown; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: redactUrl(req.url),
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  app.use(contextMiddleware);
  app.use('/api', buildApiRouter(modules));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/**
 * Everything served under `/api`. `onModule` lets the route registry attribute routes to modules
 * (see infrastructure/route-registry.ts).
 */
export function buildApiRouter(modules: ModuleDefinition[], onModule?: (name: string) => void): Router {
  const api = Router();
  api.use(apiRateLimit);
  onModule?.('platform');
  // Liveness: the process is up (no dependencies checked, so a DB outage doesn't restart it).
  api.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok', time: new Date().toISOString() });
  });
  // Readiness: database reachable, migrations applied, storage writable.
  api.get('/ready', async (_req, res) => {
    const report = await readiness();
    res
      .status(report.status === 'ready' ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json(report);
  });
  for (const m of modules) {
    onModule?.(m.name);
    const before = api.stack.length;
    m.routes?.(api);
    assertNoRootMiddleware(m.name, api.stack.slice(before));
  }
  return api;
}

/**
 * A module must mount its routers under its own prefix. `api.use(mw)` / `api.use('/', router)` would
 * run that middleware (e.g. `authenticate`) for every module registered after it.
 */
function assertNoRootMiddleware(moduleName: string, layers: { slash?: boolean; route?: unknown }[]) {
  if (layers.some((l) => !l.route && l.slash)) {
    throw new Error(
      `Module "${moduleName}" mounts middleware/router at the API root. Use api.use('/<prefix>', router).`,
    );
  }
}
