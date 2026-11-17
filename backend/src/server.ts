import { bootstrap } from './bootstrap';
import { createApp } from './app';
import { config } from './infrastructure/config';
import { logger } from './infrastructure/logger';
import { startJobWorker, stopJobWorker } from './infrastructure/jobs/queue';
import { closeSequelize } from './infrastructure/database/sequelize';

async function main() {
  const modules = await bootstrap();
  const server = createApp(modules).listen(config.PORT, () =>
    logger.info(`API listening on :${config.PORT}`),
  );
  if (config.JOBS_WORKER_ENABLED) startJobWorker(config.JOBS_POLL_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopJobWorker();
    server.close();
    await closeSequelize();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
