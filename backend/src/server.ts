import { bootstrap } from './bootstrap';
import { createApp } from './app';
import { config } from './infrastructure/config';
import { logger } from './infrastructure/logger';
import { captureError, getErrorTracker } from './infrastructure/error-tracking';
import { startJobWorker, stopJobWorker } from './infrastructure/jobs/queue';
import { closeSequelize } from './infrastructure/database/sequelize';
import { closeRedis } from './infrastructure/redis';

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
  captureError(reason, { source: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  captureError(err, { source: 'uncaughtException' }, 'fatal');
  // State is unknown after an uncaught exception: report, then let the supervisor restart us.
  void getErrorTracker()
    .flush()
    .finally(() => process.exit(1));
});

async function main() {
  const modules = await bootstrap();
  const server = createApp(modules).listen(config.PORT, () =>
    logger.info(`API listening on :${config.PORT}`),
  );
  for (const m of modules) m.attachServer?.(server);
  if (config.JOBS_WORKER_ENABLED) startJobWorker(config.JOBS_POLL_INTERVAL_MS);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    // Open websockets (live classes) would otherwise keep server.close() pending forever.
    setTimeout(() => process.exit(0), 10_000).unref();
    stopJobWorker();
    server.close();
    await closeSequelize();
    await closeRedis();
    await getErrorTracker().flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  logger.fatal({ err }, 'failed to start');
  captureError(err, { source: 'startup' }, 'fatal');
  await getErrorTracker().flush();
  process.exit(1);
});
