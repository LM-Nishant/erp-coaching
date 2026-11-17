import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { config } from './infrastructure/config';
import { logger } from './infrastructure/logger';
import { contextMiddleware } from './shared/middleware/context';
import { apiRateLimit } from './shared/middleware/security';
import { errorHandler, notFoundHandler } from './shared/middleware/error-handler';
import type { ModuleDefinition } from './shared/module';

export function createApp(modules: ModuleDefinition[]) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Content-Range', 'Accept-Ranges'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  if (!config.isTest)
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/api/health' },
        serializers: {
          req: (req: { id: unknown; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  app.use(contextMiddleware);

  const api = Router();
  api.use(apiRateLimit);
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });
  for (const m of modules) {
    const before = api.stack.length;
    m.routes?.(api);
    assertNoRootMiddleware(m.name, api.stack.slice(before));
  }
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
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
